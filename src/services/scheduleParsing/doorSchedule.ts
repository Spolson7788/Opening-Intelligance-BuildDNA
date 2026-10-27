import { Grid } from "./ooxml";
import { clean, normalizeMark, normalizeSetKey, parseFireMinutes, parseHardwareRef, parseInches, splitRoom } from "./normalize";

export type DoorField =
  | "room" | "door_mark" | "door_tag" | "elevation_type" | "configuration" | "door_size" | "width" | "height" | "thickness"
  | "description" | "function" | "door_material" | "frame_material" | "hw_ref" | "closer" | "fire_rating" | "comments" | "to_room";

export type Issue = { code: string; message: string; column?: string; value?: string };

export type ParsedDoorRow = {
  row_kind: "door" | "type_template";
  schedule_name: string | null;
  source_sheet: string;
  source_row: number; // 1-based spreadsheet row
  raw: Record<string, string>;
  door_mark_raw: string | null;
  door_mark: string | null;
  room_name: string | null; room_number: string | null; to_room: string | null;
  elevation_type: string | null; configuration: string | null; description: string | null;
  width_in: number | null; height_in: number | null; thickness_in: number | null;
  door_material: string | null; frame_material: string | null;
  fire_rating_raw: string | null; fire_rating_minutes: number | null;
  hw_ref_raw: string | null; hw_set_key: string | null;
  closer: string | null; comments: string | null;
  issues: Issue[];
};

export type DoorScheduleBlock = { schedule_name: string | null; sheet: string; header_row: number; kind: "door" | "type_template"; columns: Record<string, DoorField | null> };
export type DoorScheduleParse = { rows: ParsedDoorRow[]; blocks: DoorScheduleBlock[]; issues: Issue[] };

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/\bel_/g, " ").replace(/_sp\b/g, " ").replace(/comm\s+ments/g, "comments")
    .replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Known header synonyms (normalized). First match wins per column.
const SYNONYMS: [DoorField, RegExp][] = [
  ["to_room", /^to room( name)?$|^to$/],
  ["room", /^(room name and number|room name|room|room no|room number|location|space)$/],
  ["door_mark", /^(mark|door mark|door no|door number|door|opening|opening no|opening number|door id|no)$/],
  ["door_tag", /^door tag$/],
  ["elevation_type", /^(type mark|type|door type mark|elevation|elevation tag|elev|door elevation)$/],
  ["configuration", /^(door type|configuration|leaf config|single pair)$/],
  ["door_size", /^(door size|size|door size width height thickness|door size \(width height thickness\))$/],
  ["width", /^(width|w|wd)$/],
  ["height", /^(height|h|ht)$/],
  ["thickness", /^(thickness|thk|t|thick)$/],
  ["description", /^(description|door description|desc)$/],
  ["function", /^function$/],
  ["door_material", /^(door material|material|panel type|door matl|door construction)$/],
  ["frame_material", /^(frame material|frame|frame matl|frame type)$/],
  ["hw_ref", /^(hw group|hardware group|hw set|hardware set|hardware|hw|hdwr|hdw set|hardware group no)$/],
  ["closer", /^(closer type|closer)$/],
  ["fire_rating", /^(fire rating|rating|fire|label|fire label|fire rating min)$/],
  ["comments", /^(comments|remarks|notes|comment)$/],
];
export function headerField(h: string): DoorField | null {
  const n = normalizeHeader(h);
  if (!n) return null;
  for (const [f, re] of SYNONYMS) if (re.test(n)) return f;
  return null;
}

// Content signatures for shifted-column detection.
const CONTENT: [DoorField, RegExp][] = [
  ["hw_ref", /^(group\s*\S+|<?varies>?)$/i],
  ["fire_rating", /^\d+\s*-?\s*(min|minutes?|hr|hour)s?\.?$/i],
  ["door_material", /^(wood|solid core wood|scw|hollow metal|hm|aluminum|alum|steel|insulated steel|fiberglass|frp|glass|vinyl|hollow core|solid core|wd|al|stl|mtl)( .*)?$/i],
];

const isBlank = (r: string[]) => r.every((c) => !String(c ?? "").trim());

function headerMatches(r: string[]): number {
  const seen = new Set<DoorField>();
  for (const c of r) { const f = headerField(String(c ?? "")); if (f) seen.add(f); }
  return seen.size;
}

function titleOf(r: string[]): string | null {
  const vals = [...new Set(r.map((c) => String(c ?? "").trim()).filter(Boolean))];
  return vals.length === 1 && headerMatches(r) <= 1 ? vals[0] : null;
}

const rowSig = (r: string[]) => r.map((c) => normalizeHeader(String(c ?? ""))).join("|");

type Block = { cols: (DoorField | null)[]; sigs: string[]; kind: "door" | "type_template"; header_row: number; rows: { idx: number; cells: string[] }[]; name: string | null; repeats: number; labels: string[] };

export function parseDoorGrids(grids: Grid[]): DoorScheduleParse {
  const out: DoorScheduleParse = { rows: [], blocks: [], issues: [] };
  for (const g of grids) {
    let title: string | null = null;
    let block: Block | null = null;
    const blocks: Block[] = [];
    for (let i = 0; i < g.rows.length; i++) {
      const r = g.rows[i];
      if (isBlank(r)) continue;
      if (block && block.sigs.includes(rowSig(r))) { block.repeats++; continue; } // repeated header rows (page breaks)
      const t = titleOf(r);
      if (t && block && t === block.name) { block.repeats++; continue; } // repeated page title
      if (t && headerField(t) === null && (/schedule/i.test(t) || !block)) { title = t; block = null; continue; }
      if (headerMatches(r) >= 3) {
        // Two-row header: the next row carries sub-columns (WIDTH/HEIGHT/THICKNESS).
        const next = g.rows[i + 1] ?? [];
        const parent = r.map((c) => headerField(String(c ?? "")));
        const child = next.map((c) => headerField(String(c ?? "")));
        const twoRow = child.filter((f) => f === "width" || f === "height" || f === "thickness").length >= 2;
        const cols = parent.map((p, j) => (twoRow && child[j] && child[j] !== p ? child[j] : p));
        const sigs = twoRow ? [rowSig(r), rowSig(next)] : [rowSig(r)];
        const kind = cols.includes("door_tag") && !cols.includes("door_mark") ? "type_template" : "door";
        const labels = r.map((c, j) => { const p = String(c ?? "").replace(/\s+/g, " ").trim(); const ch = String(next[j] ?? "").replace(/\s+/g, " ").trim(); return twoRow && ch && ch !== p ? `${p} ${ch}`.trim() : p; });
        block = { cols, sigs, kind, header_row: i + 1, rows: [], name: title, repeats: 0, labels };
        blocks.push(block);
        if (twoRow) i++;
        continue;
      }
      if (block) block.rows.push({ idx: i, cells: r });
    }
    for (const b of blocks) {
      const blockIssues: Issue[] = [];
      const label = (j: number) => b.labels[j] || `column ${j + 1}`;
      // Duplicate header fields: keep the first, mark later ones unknown so content detection can place them.
      const seen = new Set<DoorField>();
      b.cols = b.cols.map((f, j) => {
        if (!f) return f;
        if (seen.has(f)) { blockIssues.push({ code: "duplicate_header", message: `Header "${label(j)}" repeats ${f}; resolved by content`, column: label(j) }); return null; }
        seen.add(f); return f;
      });
      // Content-based detection of shifted columns.
      const share = (j: number, re: RegExp) => {
        const vals = b.rows.map((r) => String(r.cells[j] ?? "").trim()).filter(Boolean);
        return vals.length ? vals.filter((v) => re.test(v)).length / vals.length : 0;
      };
      const filled = (j: number) => b.rows.some((r) => String(r.cells[j] ?? "").trim());
      for (const [field, re] of CONTENT) {
        const owner = b.cols.indexOf(field);
        if (owner >= 0 && share(owner, re) >= 0.6) continue;
        let best = -1, bestShare = 0;
        b.cols.forEach((f, j) => {
          if (f === field || f === "description" || f === "comments" || f === "room" || f === "to_room") return;
          const s = share(j, re); if (s >= 0.6 && s > bestShare) { best = j; bestShare = s; }
        });
        if (best >= 0) {
          blockIssues.push({ code: "column_shift", message: `Column "${label(best)}" contains ${field} values; mapped by content`, column: label(best) });
          if (owner >= 0 && !filled(owner)) b.cols[owner] = null;
          b.cols[best] = field;
        }
      }
      b.cols.forEach((f, j) => {
        if (f === "frame_material" && !filled(j)) blockIssues.push({ code: "empty_column", message: `Column "${label(j)}" (frame material) is empty in every row`, column: label(j) });
      });
      if (b.repeats) blockIssues.push({ code: "repeated_header", message: `Skipped ${b.repeats} repeated title/header row(s)` });
      out.blocks.push({ schedule_name: b.name, sheet: g.name, header_row: b.header_row, kind: b.kind,
        columns: Object.fromEntries(b.cols.map((f, j) => [label(j), f])) });
      out.issues.push(...blockIssues.map((x) => ({ ...x, message: `${b.name ?? g.name}: ${x.message}` })));
      for (const r of b.rows) {
        const get = (f: DoorField) => { const j = b.cols.indexOf(f); return j >= 0 ? clean(r.cells[j]) : null; };
        const raw: Record<string, string> = {};
        b.cols.forEach((_f, j) => { const v = clean(r.cells[j]); if (v) raw[label(j)] = v; });
        const markRaw = b.kind === "door" ? get("door_mark") : get("door_tag");
        if (!markRaw) continue; // notes / legend rows
        const issues: Issue[] = [];
        const room = splitRoom(get("room"));
        let width = parseInches(get("width")), height = parseInches(get("height")), thick = parseInches(get("thickness"));
        const size = get("door_size");
        if (size && width === null) {
          const parts = size.split(/\s*[xX×]\s*/);
          width = parseInches(parts[0]); height = parseInches(parts[1]); thick = parts[2] ? parseInches(parts[2]) : thick;
        }
        for (const [f, v, raw2] of [["width", width, get("width") ?? size], ["height", height, get("height")], ["thickness", thick, get("thickness")]] as const)
          if (v === null && raw2) issues.push({ code: "unparsed_size", message: `Could not read ${f} "${raw2}"`, value: String(raw2) });
        const fireRaw = get("fire_rating");
        const fire = parseFireMinutes(fireRaw);
        if (fire === "invalid") issues.push({ code: "unparsed_fire_rating", message: `Could not read fire rating "${fireRaw}"`, value: fireRaw ?? "" });
        const hwRaw = get("hw_ref");
        const hw = parseHardwareRef(hwRaw);
        if (hw.varies) issues.push({ code: "hw_varies", message: "Hardware group is <varies>", value: hwRaw ?? "" });
        else if (!hwRaw && b.kind === "door") issues.push({ code: "hw_missing", message: "No hardware group" });
        const mark = normalizeMark(markRaw);
        out.rows.push({
          row_kind: b.kind, schedule_name: b.name, source_sheet: g.name, source_row: r.idx + 1, raw,
          door_mark_raw: markRaw, door_mark: mark,
          room_name: room.name, room_number: room.number, to_room: get("to_room"),
          elevation_type: get("elevation_type"), configuration: get("configuration"), description: get("description"),
          width_in: width, height_in: height, thickness_in: thick,
          door_material: get("door_material"), frame_material: get("frame_material"),
          fire_rating_raw: fireRaw, fire_rating_minutes: typeof fire === "number" ? fire : null,
          hw_ref_raw: hwRaw, hw_set_key: hw.key ? normalizeSetKey(hw.key) : null,
          closer: get("closer"), comments: get("comments"), issues,
        });
      }
    }
  }
  if (!out.blocks.length) out.issues.push({ code: "no_header", message: "No door schedule header row was found" });
  return out;
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF) to a single grid. */
export function readCsv(textIn: string, name = "CSV"): Grid {
  const s = textIn.replace(/^\uFEFF/, "");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return { name, rows: rows.map((r) => Array.from({ length: width }, (_, j) => r[j] ?? "")) };
}
