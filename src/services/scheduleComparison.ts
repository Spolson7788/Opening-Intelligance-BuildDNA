import { normalizeMark } from "./scheduleParsing/normalize";
import { scheduledLeafWidths } from "./scheduleImport";

// M4: compare what a confirmed schedule import said (immutable schedule_rows /
// schedule_set_items / schedule_import_effects) with the current field state of
// the import's building. Pure read: this module never writes. Snapshots store
// its output (see routes/scheduleComparisons.ts).
type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export const COMPARISON_ENGINE_VERSION = 2;
export const COMPARISON_CATEGORIES = ["scheduled_not_surveyed", "scheduled_opening_missing", "not_in_schedule", "field_mismatch", "hardware_difference", "open_follow_up"] as const;
export type ComparisonCategory = typeof COMPARISON_CATEGORIES[number];
export type OpeningStatus = "matched" | "differences" | "not_surveyed" | "missing" | "not_in_schedule";

/** One difference (one CSV line). */
export type ComparisonLine = {
  category: ComparisonCategory; mark: string | null; opening_id: string | null; opening_code: string | null;
  entity: "opening" | "door_leaf" | "frame" | "hardware" | "schedule_row" | "follow_up"; field: string | null;
  schedule_value: string | null; field_value: string | null; note: string | null;
  /** v2: hardware lines are "set" (one per differing opening set, counted) or "item" (detail under it, not counted). */
  level?: "set" | "item"; change?: "missing" | "extra" | "changed";
};
export type HardwareSetResult = {
  set_key: string | null; heading: string | null; status: "matches" | "differs";
  scheduled_items: number; field_items: number; missing: number; extra: number; changed: number;
};
export type ComparisonOpening = {
  mark: string | null; source_row: number | null; opening_id: string | null; opening_code: string | null; floor_label: string | null;
  match: "mark" | "code" | null; surveyed: boolean; surveyed_at: string | null; surveyed_by_role: string | null;
  status: OpeningStatus; set_key: string | null; lines: ComparisonLine[]; hardware_set?: HardwareSetResult | null; match_candidates?: string[];
};
export type ComparisonResult = { summary: Record<string, number>; openings: ComparisonOpening[] };

export const SIZE_TOLERANCE_IN = 0.125;
const VERIFIED = new Set(["good", "worn", "failed"]);
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
const text = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
const show = (v: unknown): string | null => (blank(v) ? null : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
const numDiff = (a: unknown, b: unknown) => Math.abs(Number(a) - Number(b)) > SIZE_TOLERANCE_IN + 1e-9;
const hwVerified = (h: any) => h.review_state === "reviewed" || h.identity_status === "established" || VERIFIED.has(h.condition);

/** Effective hardware set for a row, from the resolutions stored on confirm (same order as planImport). */
export function effectiveSet(r: any, res: any, setKeys: Set<string>): string | null {
  const k = r.hw_set_key as string | null;
  if (!k) return null;
  const pick = (t: unknown) => (typeof t === "string" && setKeys.has(t) ? t : null);
  if (res?.row_sets && Object.hasOwn(res.row_sets, r.id)) return pick(res.row_sets[r.id]);
  if (res?.set_map && Object.hasOwn(res.set_map, k)) return pick(res.set_map[k]);
  return setKeys.has(k) ? k : null;
}

const CODE_PREFIX = /^\s*(DOOR|DR|OPENING|OPNG|OPG)(?=[\s.#:_\-]|\d)[\s.#:_\-]*/;
/**
 * Loose opening-code key (v2): ignore case, a leading "Door"/"Dr"/"Opening" word, and every
 * hyphen, dot, underscore, space or other punctuation; leading zeros of numeric parts are
 * dropped. "101-A", "101A", "101 a", "Door 101-A" and "0101a" all give "101A". Two numbers
 * separated only by punctuation keep a "." between them so "1-01" ("1.1") is not "11".
 */
export function looseCodeKey(v: unknown): string | null {
  let s = String(v ?? "").toUpperCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(CODE_PREFIX, "");
  const tokens = s.match(/[A-Z]+|[0-9]+/g) ?? [];
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const tk = /^[0-9]+$/.test(tokens[i]) ? tokens[i].replace(/^0+(?=\d)/, "") : tokens[i];
    if (i > 0 && /^[0-9]/.test(tk) && /[0-9]$/.test(out)) out += ".";
    out += tk;
  }
  return out || null;
}

export async function compareImport(db: Db, importId: string): Promise<ComparisonResult | null> {
  const imp = (await db.query("SELECT * FROM schedule_imports WHERE id=$1", [importId])).rows[0];
  if (!imp) return null;
  const res = imp.resolutions ?? {};
  const rows = (await db.query("SELECT * FROM schedule_rows WHERE import_id=$1 AND row_kind='door' ORDER BY source_sheet, source_row", [importId])).rows;
  const sets = (await db.query("SELECT id, set_key, heading_raw FROM schedule_hardware_sets WHERE import_id=$1", [importId])).rows;
  const items = (await db.query("SELECT * FROM schedule_set_items WHERE import_id=$1 ORDER BY set_id, position", [importId])).rows;
  const followUps = (await db.query("SELECT row_id, opening_id, reason, detail FROM schedule_row_follow_ups WHERE import_id=$1 AND status='open'", [importId])).rows;
  const openings = (await db.query(`SELECT id, opening_code, schedule_door_mark, floor_label, location_description, fire_rated, opening_configuration, completion_state, completed_at, completed_by_user_id, status
    FROM openings WHERE building_id=$1 ORDER BY opening_code`, [imp.building_id])).rows;
  const ids = openings.map((o: any) => o.id);
  const q = async (sql: string) => (ids.length ? (await db.query(sql, [ids])).rows : []);
  const leaves = await q("SELECT * FROM door_leaves WHERE opening_id = ANY($1::uuid[])");
  const frames = await q("SELECT * FROM opening_frames WHERE opening_id = ANY($1::uuid[])");
  const hardware = await q("SELECT * FROM hardware_components WHERE opening_id = ANY($1::uuid[]) AND lifecycle_state='active' ORDER BY created_at, id");
  const effects = await q("SELECT entity_id, item_signature FROM schedule_import_effects WHERE entity_type='hardware' AND action='create' AND item_signature IS NOT NULL AND entity_id IN (SELECT id FROM hardware_components WHERE opening_id = ANY($1::uuid[]))");
  const obs = await q("SELECT o.opening_id, max(o.recorded_at) AS at, (array_agg(u.role ORDER BY o.recorded_at DESC))[1] AS role FROM condition_observations o LEFT JOIN users u ON u.id=o.recorded_by_user_id WHERE o.opening_id = ANY($1::uuid[]) GROUP BY o.opening_id");
  const photos = await q("SELECT opening_id, count(*)::int AS n FROM photos WHERE opening_id = ANY($1::uuid[]) GROUP BY opening_id");
  const insp = await q("SELECT i.opening_id, max(i.created_at) AS at, (array_agg(u.role ORDER BY i.created_at DESC))[1] AS role FROM inspection_events i LEFT JOIN users u ON u.id=i.performed_by_user_id WHERE i.opening_id = ANY($1::uuid[]) GROUP BY i.opening_id");
  const completers = await q("SELECT DISTINCT u.id, u.role FROM users u JOIN openings o ON o.completed_by_user_id=u.id WHERE o.id = ANY($1::uuid[])");

  const by = <T,>(list: any[], key: string) => { const m = new Map<string, T[]>(); for (const x of list) (m.get(x[key]) ?? m.set(x[key], []).get(x[key])!).push(x); return m; };
  const leavesOf = by<any>(leaves, "opening_id"), framesOf = by<any>(frames, "opening_id"), hwOf = by<any>(hardware, "opening_id");
  const sigOf = new Map<string, string>(effects.map((e: any) => [e.entity_id, e.item_signature]));
  const obsOf = new Map(obs.map((o: any) => [o.opening_id, o])), inspOf = new Map(insp.map((o: any) => [o.opening_id, o]));
  const photoOf = new Map(photos.map((p: any) => [p.opening_id, p.n])), roleOf = new Map(completers.map((u: any) => [u.id, u.role]));
  const setKeys = new Set<string>(sets.map((s: any) => s.set_key)), setIdOf = new Map(sets.map((s: any) => [s.set_key, s.id])), headingOf = new Map<string, string>(sets.map((s: any) => [s.set_key, s.heading_raw]));
  const itemsOf = by<any>(items, "set_id");
  const followOf = new Map(followUps.map((f: any) => [f.row_id, f]));

  const survey = (o: any) => {
    const ob: any = obsOf.get(o.id), ins: any = inspOf.get(o.id);
    const surveyed = o.completion_state === "complete" || (leavesOf.get(o.id) ?? []).some((l) => VERIFIED.has(l.condition))
      || (framesOf.get(o.id) ?? []).some((f) => VERIFIED.has(f.condition)) || (hwOf.get(o.id) ?? []).some(hwVerified)
      || !!ob || !!ins || (photoOf.get(o.id) ?? 0) > 0;
    const stamps = [[o.completed_at, roleOf.get(o.completed_by_user_id) ?? null], [ob?.at, ob?.role ?? null], [ins?.at, ins?.role ?? null]]
      .filter(([t]) => t).map(([t, r]) => [new Date(t as any).toISOString(), r] as const).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    return { surveyed, surveyed_at: stamps[0]?.[0] ?? null, surveyed_by_role: (stamps[0]?.[1] as string | null) ?? null };
  };

  // Effective marks (same resolutions as confirm), duplicates are not matched.
  const markOf = new Map<string, string | null>();
  for (const r of rows) { const rr = res.rows?.[r.id]; markOf.set(r.id, rr?.skip ? null : rr?.mark !== undefined ? normalizeMark(rr.mark) : r.door_mark); }
  const count = new Map<string, number>(); for (const m of markOf.values()) if (m) count.set(m, (count.get(m) ?? 0) + 1);
  const byMark = new Map(openings.filter((o: any) => o.schedule_door_mark).map((o: any) => [o.schedule_door_mark, o]));
  // Pass 1: exact schedule mark. Pass 2: loose code key against the opening code (and a
  // differently written field mark) of openings not taken in pass 1. Ambiguity is flagged,
  // never guessed: several candidate openings for one row, or several rows for one key.
  type Assign = { o: any; match: "mark" | "code" } | { reason: string; candidates?: string[] };
  const assign = new Map<string, Assign>();
  const used = new Set<string>();
  for (const r of rows) {
    const mark = markOf.get(r.id) ?? null;
    if (!mark) { assign.set(r.id, { reason: res.rows?.[r.id]?.skip ? "skipped_by_user" : "no_mark" }); continue; }
    if ((count.get(mark) ?? 0) > 1) { assign.set(r.id, { reason: "duplicate_mark" }); continue; }
    const o = byMark.get(mark);
    if (o && !used.has(o.id)) { used.add(o.id); assign.set(r.id, { o, match: "mark" }); }
  }
  const pending = rows.filter((r: any) => !assign.has(r.id));
  const keyOfRow = new Map<string, string | null>(pending.map((r: any) => [r.id, looseCodeKey(markOf.get(r.id))]));
  const rowsPerKey = new Map<string, number>(); for (const k of keyOfRow.values()) if (k) rowsPerKey.set(k, (rowsPerKey.get(k) ?? 0) + 1);
  const free = openings.filter((o: any) => !used.has(o.id));
  for (const r of pending) {
    const k = keyOfRow.get(r.id);
    const cands = k ? free.filter((o: any) => looseCodeKey(o.opening_code) === k || (o.schedule_door_mark && looseCodeKey(o.schedule_door_mark) === k)) : [];
    if (!cands.length) { assign.set(r.id, { reason: "no_opening" }); continue; }
    if (cands.length > 1 || (rowsPerKey.get(k!) ?? 0) > 1) { assign.set(r.id, { reason: "ambiguous_code_match", candidates: cands.map((o: any) => o.opening_code) }); continue; }
    assign.set(r.id, { o: cands[0], match: "code" });
  }
  for (const a of assign.values()) if ("o" in a) used.add(a.o.id);
  const out: ComparisonOpening[] = [];

  for (const r of rows) {
    const mark = markOf.get(r.id) ?? null;
    const base = { mark: mark ?? r.door_mark ?? r.door_mark_raw ?? null, source_row: r.source_row, set_key: null as string | null };
    const missing = (note: string, o: any = null, m: "mark" | "code" | null = null, candidates?: string[]) => out.push({ ...base, opening_id: o?.id ?? null, opening_code: o?.opening_code ?? null, floor_label: o?.floor_label ?? null, match: m,
      surveyed: false, surveyed_at: null, surveyed_by_role: null, status: "missing", ...(candidates ? { match_candidates: candidates } : {}),
      lines: [{ category: "scheduled_opening_missing", mark: base.mark, opening_id: o?.id ?? null, opening_code: o?.opening_code ?? null, entity: "schedule_row", field: null, schedule_value: `row ${r.source_row}`,
        field_value: candidates ? candidates.join("; ") : null, note: candidates ? `ambiguous_code_match: ${candidates.length} candidate opening(s), ${note === "ambiguous_code_match" ? "not guessed" : note}` : note }] });
    const a = assign.get(r.id)!;
    if (!("o" in a)) { missing(a.reason, null, null, a.reason === "ambiguous_code_match" ? a.candidates : undefined); continue; }
    const o: any = a.o, match = a.match;
    if (o.status === "decommissioned") { missing("decommissioned", o, match); continue; }
    const s = survey(o);
    const lines: ComparisonLine[] = [];
    const line = (category: ComparisonCategory, entity: ComparisonLine["entity"], field: string | null, sv: unknown, fv: unknown, note: string | null = null) =>
      lines.push({ category, mark, opening_id: o.id, opening_code: o.opening_code, entity, field, schedule_value: show(sv), field_value: show(fv), note });
    const setKey = effectiveSet(r, res, setKeys);
    const fu: any = followOf.get(r.id);
    if (fu) line("open_follow_up", "follow_up", "hardware", r.hw_ref_raw, null, fu.reason);
    if (!s.surveyed) {
      line("scheduled_not_surveyed", "opening", null, null, null, match === "code" ? "matched by code" : null);
      out.push({ ...base, mark, opening_id: o.id, opening_code: o.opening_code, floor_label: o.floor_label, match, ...s, status: "not_surveyed", set_key: setKey, lines });
      continue;
    }
    const pair = /\b(pair|double|dbl)\b/i.test(`${r.configuration ?? ""} ${r.description ?? ""}`);
    const fire = r.fire_rating_minutes === null || r.fire_rating_minutes === undefined ? null : r.fire_rating_minutes > 0;
    const cmpBool = (entity: ComparisonLine["entity"], field: string, sv: boolean | null, fv: unknown, note: string | null = null) => { if (sv !== null && !blank(fv) && Boolean(fv) !== sv) line("field_mismatch", entity, field, sv, fv, note); };
    const cmpText = (entity: ComparisonLine["entity"], field: string, sv: unknown, fv: unknown) => { if (!blank(sv) && !blank(fv) && text(sv) !== text(fv)) line("field_mismatch", entity, field, sv, fv); };
    const cmpNum = (entity: ComparisonLine["entity"], field: string, sv: unknown, fv: unknown, note: string | null = null) => { if (!blank(sv) && !blank(fv) && numDiff(sv, fv)) line("field_mismatch", entity, field, Number(sv), Number(fv), note); };
    if (o.completion_state === "complete") {
      cmpText("opening", "opening_configuration", pair ? "pair" : "single", o.opening_configuration);
      cmpBool("opening", "fire_rated", fire, o.fire_rated, r.fire_rating_raw ? `schedule: ${r.fire_rating_raw}` : null);
    }
    const widths = scheduledLeafWidths(r, pair);
    for (const l of leavesOf.get(o.id) ?? []) if (VERIFIED.has(l.condition)) {
      const w = !pair ? (blank(r.width_in) ? null : Number(r.width_in)) : l.leaf_role === "inactive" ? widths.inactive : widths.active;
      cmpText("door_leaf", `${l.leaf_role}.material`, r.door_material, l.material);
      cmpNum("door_leaf", `${l.leaf_role}.width_in`, w, l.width_in, widths.estimated ? "estimated even split" : null);
      cmpNum("door_leaf", `${l.leaf_role}.height_in`, r.height_in, l.height_in);
      cmpNum("door_leaf", `${l.leaf_role}.thickness_in`, r.thickness_in, l.thickness_in);
      cmpBool("door_leaf", `${l.leaf_role}.fire_rated`, fire, l.fire_rated);
    }
    for (const f of framesOf.get(o.id) ?? []) if (VERIFIED.has(f.condition)) {
      cmpText("frame", "material", r.frame_material, f.material);
      cmpNum("frame", "width_in", r.width_in, f.width_in); cmpNum("frame", "height_in", r.height_in, f.height_in);
    }
    // Hardware as a set (v2): the opening's scheduled set vs the active field hardware on it.
    // One set-level line when the set differs; item lines (missing / extra / changed) under it.
    const mine = hwOf.get(o.id) ?? [];
    const taken = new Set<string>();
    const expected = setKey ? itemsOf.get(setIdOf.get(setKey) as string) ?? [] : [];
    const items: ComparisonLine[] = [];
    let nMissing = 0, nExtra = 0;
    const changedItems = new Set<string>();
    const setLabel = setKey ? `set ${setKey}` : "no scheduled set";
    const item = (change: "missing" | "extra" | "changed", field: string, sv: unknown, fv: unknown, note: string | null) =>
      items.push({ category: "hardware_difference", level: "item", change, mark, opening_id: o.id, opening_code: o.opening_code, entity: "hardware", field: `${setLabel}: ${field}`.slice(0, 240), schedule_value: show(sv), field_value: show(fv), note });
    for (const it of expected) {
      const sig = `${setKey}#${it.position}`;
      let h = mine.find((x) => !taken.has(x.id) && sigOf.get(x.id) === sig);
      let how = "schedule";
      if (!h && it.component_type !== "other") { h = mine.find((x) => !taken.has(x.id) && !sigOf.has(x.id) && x.component_type === it.component_type); how = "field-owned"; }
      const label = `#${it.position} ${it.description}`.slice(0, 200);
      if (!h) { nMissing++; item("missing", label, `${it.component_type}${it.qty ? " x" + it.qty : ""}`, null, "missing: scheduled item not found in field"); continue; }
      taken.add(h.id);
      if (!hwVerified(h)) continue;
      const note = how === "field-owned" ? "changed (field-owned, matched by type)" : "changed";
      const diff = (f: string, sv: unknown, fv: unknown) => { if (!blank(sv) && !blank(fv) && (f === "quantity" ? Number(sv) !== Number(fv) : text(sv) !== text(fv))) { changedItems.add(h.id); item("changed", `${label} ${f}`, sv, fv, note); } };
      diff("manufacturer", it.manufacturer ?? it.manufacturer_raw, h.manufacturer); diff("model_number", it.catalog, h.model_number);
      diff("finish", it.finish, h.finish); diff("quantity", it.qty && it.qty > 0 ? it.qty : null, h.quantity);
      if (h.condition === "failed") { changedItems.add(h.id); item("changed", label, "installed", "failed", "changed: verified failed, needs replacement"); }
    }
    for (const h of mine) if (!taken.has(h.id)) { nExtra++; item("extra", `${h.component_type}${h.position_label ? " " + h.position_label : ""}`, null,
      [h.component_type, h.manufacturer, h.model_number].filter(Boolean).join(" "), "extra: field hardware not in schedule"); }
    let hardwareSet: HardwareSetResult | null = null;
    if (setKey || mine.length) {
      const differs = nMissing + nExtra + changedItems.size > 0;
      hardwareSet = { set_key: setKey, heading: setKey ? headingOf.get(setKey) ?? null : null, status: differs ? "differs" : "matches",
        scheduled_items: expected.length, field_items: mine.length, missing: nMissing, extra: nExtra, changed: changedItems.size };
      if (differs) {
        lines.push({ category: "hardware_difference", level: "set", mark, opening_id: o.id, opening_code: o.opening_code, entity: "hardware", field: setLabel,
          schedule_value: setKey ? `${setKey}${hardwareSet.heading ? " (" + hardwareSet.heading + ")" : ""}: ${expected.length} item(s)` : null,
          field_value: `${mine.length} item(s)`, note: `set differs: ${nMissing} missing, ${nExtra} extra, ${changedItems.size} changed` });
        lines.push(...items);
      }
    }
    const diffs = lines.some((x) => x.category === "field_mismatch" || x.category === "hardware_difference");
    out.push({ ...base, mark, opening_id: o.id, opening_code: o.opening_code, floor_label: o.floor_label, match, ...s, status: diffs ? "differences" : "matched", set_key: setKey, lines, hardware_set: hardwareSet });
  }
  for (const o of openings) if (!used.has(o.id)) {
    const s = survey(o);
    out.push({ mark: o.schedule_door_mark ?? null, source_row: null, opening_id: o.id, opening_code: o.opening_code, floor_label: o.floor_label, match: null, ...s, status: "not_in_schedule", set_key: null,
      lines: [{ category: "not_in_schedule", mark: o.schedule_door_mark ?? null, opening_id: o.id, opening_code: o.opening_code, entity: "opening", field: null, schedule_value: null,
        field_value: o.opening_code, note: s.surveyed ? "surveyed" : "not surveyed" }] });
  }
  const all = out.flatMap((x) => x.lines);
  const counted = all.filter((l) => l.level !== "item");
  const hwSets = out.map((x) => x.hardware_set).filter((h): h is HardwareSetResult => !!h);
  const summary: Record<string, number> = {
    schedule_rows: rows.length, live_openings: openings.length,
    matched_by_mark: out.filter((x) => x.source_row !== null && x.match === "mark" && x.status !== "missing").length,
    matched_by_code: out.filter((x) => x.match === "code").length,
    surveyed: out.filter((x) => x.source_row !== null && x.surveyed).length,
    openings_matched: out.filter((x) => x.status === "matched").length,
    openings_with_differences: out.filter((x) => x.status === "differences").length,
    ambiguous_code_matches: out.filter((x) => x.match_candidates).length,
    hardware_sets_compared: hwSets.length,
    hardware_sets_matched: hwSets.filter((h) => h.status === "matches").length,
    hardware_sets_differ: hwSets.filter((h) => h.status === "differs").length,
    hardware_items_missing: hwSets.reduce((n, h) => n + h.missing, 0),
    hardware_items_extra: hwSets.reduce((n, h) => n + h.extra, 0),
    hardware_items_changed: hwSets.reduce((n, h) => n + h.changed, 0),
    lines: all.length,
  };
  // Category counts are per opening (hardware: per opening set); item detail lines are not counted.
  for (const c of COMPARISON_CATEGORIES) summary[c] = counted.filter((l) => l.category === c).length;
  return { summary, openings: out };
}

export const CSV_COLUMNS = ["import_id", "building", "mark", "opening_code", "match", "category", "level", "hardware_set", "change", "entity", "field", "schedule_value", "field_value", "surveyed", "surveyed_by_role", "surveyed_at", "note"] as const;

/** Spreadsheet-safe cell: formula guard (= + - @ tab CR get a leading '), then RFC 4180 quoting. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type CsvLine = ComparisonLine & { level?: "set" | "item" | "opening" };
/** CSV rows: every line, plus a set-level row for each hardware set that matches (a differing set already has its set line). */
export function csvLines(o: ComparisonOpening): CsvLine[] {
  const hs = o.hardware_set;
  const rows: CsvLine[] = [];
  for (const l of o.lines) rows.push(l);
  if (hs && hs.status === "matches") rows.push({ category: "" as any, level: "set", mark: o.mark, opening_id: o.opening_id, opening_code: o.opening_code, entity: "hardware",
    field: hs.set_key ? `set ${hs.set_key}` : "no scheduled set", schedule_value: hs.set_key ? `${hs.set_key}${hs.heading ? " (" + hs.heading + ")" : ""}: ${hs.scheduled_items} item(s)` : null,
    field_value: `${hs.field_items} item(s)`, note: "set matches" });
  return rows;
}
export const csvRowCount = (result: { openings: ComparisonOpening[] }) => result.openings.reduce((n, o) => n + csvLines(o).length, 0);

export function comparisonCsv(importId: string, building: string, result: { openings: ComparisonOpening[] }): string {
  const out = [CSV_COLUMNS.join(",")];
  for (const o of result.openings) for (const l of csvLines(o))
    out.push([importId, building, l.mark, l.opening_code, o.match === "code" ? "matched by code" : o.match ?? "", l.category, l.level ?? "opening",
      l.entity === "hardware" ? o.hardware_set?.set_key ?? o.set_key ?? "" : "", l.change ?? "", l.entity, l.field, l.schedule_value, l.field_value,
      o.surveyed ? "yes" : "no", o.surveyed_by_role, o.surveyed_at, l.note].map(csvCell).join(","));
  return out.join("\r\n") + "\r\n";
}