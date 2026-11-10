import { randomBytes, randomUUID } from "node:crypto";
import { normalizeMark } from "./scheduleParsing/normalize";
import { pairLeafWidths } from "../lib/inchMeasure";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export type Resolutions = {
  /** Per schedule row: skip it, or give it a corrected door mark (e.g. duplicate 150 -> 150A). */
  rows?: Record<string, { skip?: boolean; mark?: string }>;
  /** Door hardware reference -> hardware set key ("1" -> "1-INT"); null means "no hardware". */
  set_map?: Record<string, string | null>;
  /** Per schedule row: which lettered variant applies ("1" -> "1-GAR" for this door only); null means "no hardware". Wins over set_map. */
  row_sets?: Record<string, string | null>;
  /** Item ids flagged for review that the user accepts as parsed. */
  accept_items?: string[];
  /** Explicit per-field overwrites of field-verified values: "<entity>:<entityId>:<field>". */
  overwrite?: string[];
};

export type ValidationIssue = { code: string; severity: "blocker" | "warning" | "info"; message: string; row_ids?: string[]; item_ids?: string[]; key?: string; variants?: string[]; unresolved_row_ids?: string[] };
/** Why an imported opening got no hardware and needs a follow-up (stored per row on confirm). */
export type FollowUpReason = "hw_missing" | "hw_varies" | "hw_group_x" | "hw_group_undefined" | "hw_variant_none" | "hw_none_chosen";
export type FollowUp = { reason: FollowUpReason; detail: string | null };
export type FieldChange = { entity: "opening" | "door_leaf" | "frame" | "hardware"; entity_id: string | null; field: string; from: unknown; to: unknown;
  status: "same" | "fill" | "update" | "protected" | "overwrite"; overwrite_key: string | null };
export type HardwarePlan = { item_id: string; signature: string; description: string; item_type: string; component_type: string; qty: number | null;
  action: "add" | "update" | "unchanged" | "field_present" | "needs_review" | "protected"; component_id: string | null; changes: FieldChange[] };
export type OpeningPlan = { row_id: string; source_row: number; mark: string | null; action: "create" | "update" | "unchanged" | "skip";
  skip_reason?: string; opening_id: string | null; opening_code: string | null; set_key: string | null; fields: FieldChange[]; leaves: { role: string; id: string | null; create: boolean }[];
  frame: { id: string | null; create: boolean } | null; hardware: HardwarePlan[];
  /** Lettered-variant choice this door needs (Group 1 vs 1-EXT/1-GAR/1-INT); pending blocks confirm. */
  variant_choice: { group: string; options: string[]; chosen: string | null; pending: boolean } | null;
  follow_up: FollowUp | null };
export type ImportPlan = { issues: ValidationIssue[]; openings: OpeningPlan[]; summary: Record<string, number>; blocked: boolean };

const VERIFIED_CONDITIONS = new Set(["good", "worn", "failed"]);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const eq = (a: unknown, b: unknown) => {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === "number" || typeof b === "number" || (typeof a === "string" && /^-?\d+(\.\d+)?$/.test(a) && typeof b !== "boolean")) {
    const x = num(a), y = num(b); if (x !== null && y !== null && !Number.isNaN(x) && !Number.isNaN(y)) return Math.abs(x - y) < 0.001;
  }
  return String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();
};

function change(entity: FieldChange["entity"], id: string | null, field: string, from: unknown, to: unknown, verified: boolean, overwrite: Set<string>): FieldChange | null {
  if (to === null || to === undefined || to === "") return null; // schedule is silent: never clear a value
  const key = id ? `${entity}:${id}:${field}` : null;
  if (!id) return { entity, entity_id: null, field, from: null, to, status: "fill", overwrite_key: null };
  if (eq(from, to)) return { entity, entity_id: id, field, from, to, status: "same", overwrite_key: null };
  if (from === null || from === undefined || from === "") return { entity, entity_id: id, field, from, to, status: "fill", overwrite_key: null };
  if (!verified) return { entity, entity_id: id, field, from, to, status: "update", overwrite_key: null };
  return { entity, entity_id: id, field, from, to, status: key && overwrite.has(key) ? "overwrite" : "protected", overwrite_key: key };
}
const applies = (c: FieldChange) => c.status === "fill" || c.status === "update" || c.status === "overwrite";

export function locationFor(r: any): string | null {
  const room = [r.room_name, r.room_number].filter(Boolean).join(" ");
  const s = [room, r.to_room ? `(to ${r.to_room})` : ""].filter(Boolean).join(" ").trim();
  return s ? s.slice(0, 500) : null;
}
export function configurationFor(r: any): "single" | "pair" {
  return /\b(pair|double|dbl)\b/i.test(`${r.configuration ?? ""} ${r.description ?? ""}`) ? "pair" : "single";
}

export function scheduledLeafWidths(row: { width_in?: unknown; description?: string | null; configuration?: string | null; comments?: string | null; raw?: unknown }, pair: boolean) {
  const width = row.width_in === null || row.width_in === undefined || row.width_in === "" ? null : Number(row.width_in);
  const rawTexts = row.raw && typeof row.raw === "object" ? Object.values(row.raw as Record<string, unknown>).map((value) => value == null ? null : String(value)) : [];
  return pairLeafWidths({ pair, widthIn: width != null && Number.isFinite(width) ? width : null, texts: [row.description, row.configuration, row.comments, ...rawTexts] });
}

export async function loadImport(db: Db, id: string) {
  const imp = (await db.query("SELECT * FROM schedule_imports WHERE id=$1", [id])).rows[0];
  if (!imp) return null;
  const rows = (await db.query("SELECT * FROM schedule_rows WHERE import_id=$1 ORDER BY source_sheet, source_row", [id])).rows;
  const sets = (await db.query("SELECT * FROM schedule_hardware_sets WHERE import_id=$1 ORDER BY source_table, set_key", [id])).rows;
  const items = (await db.query("SELECT * FROM schedule_set_items WHERE import_id=$1 ORDER BY set_id, position", [id])).rows;
  return { imp, rows, sets, items };
}

export async function planImport(db: Db, loaded: NonNullable<Awaited<ReturnType<typeof loadImport>>>, res: Resolutions = {}): Promise<ImportPlan> {
  const { imp, rows, sets, items } = loaded;
  const overwrite = new Set(res.overwrite ?? []);
  const accepted = new Set(res.accept_items ?? []);
  const issues: ValidationIssue[] = [];
  for (const i of imp.parse_report?.issues ?? []) issues.push({ code: i.code, severity: "info", message: i.message });

  const doorRows = rows.filter((r: any) => r.row_kind === "door");
  const templates = rows.filter((r: any) => r.row_kind === "type_template");
  if (templates.length) issues.push({ code: "type_template_rows", severity: "info", message: `${templates.length} type-template row(s) (e.g. units/cottages) describe door types, not openings; they are not imported`, row_ids: templates.map((r: any) => r.id) });

  // Effective marks after user resolutions.
  const markOf = new Map<string, string | null>();
  for (const r of doorRows) {
    const rr = res.rows?.[r.id];
    markOf.set(r.id, rr?.skip ? null : rr?.mark !== undefined ? normalizeMark(rr.mark) : r.door_mark);
  }
  const byMark = new Map<string, any[]>();
  for (const r of doorRows) { const m = markOf.get(r.id); if (m) (byMark.get(m) ?? byMark.set(m, []).get(m)!).push(r); }
  const duplicates = new Set<string>();
  for (const [m, list] of byMark) if (list.length > 1) {
    duplicates.add(m);
    issues.push({ code: "duplicate_mark", severity: "blocker", key: m, message: `Door mark ${m} appears on ${list.length} rows (${list.map((x: any) => "row " + x.source_row).join(", ")}); skip or re-mark all but one`, row_ids: list.map((x: any) => x.id) });
  }

  // Hardware set resolution.
  const setByKey = new Map<string, any>(sets.map((s: any) => [s.set_key, s]));
  const itemsBySet = new Map<string, any[]>();
  for (const it of items) (itemsBySet.get(it.set_id) ?? itemsBySet.set(it.set_id, []).get(it.set_id)!).push(it);
  /** Lettered variants of a group that is not itself defined ("1" -> 1-EXT, 1-GAR, 1-INT). */
  const variantsOf = (k: string): string[] => setByKey.has(k) ? [] : sets.filter((s: any) => s.set_key.startsWith(k + "-")).map((s: any) => s.set_key).sort();
  /** Effective set for one door row: per-row choice, then bulk set_map, then the literal reference. */
  const rowSet = (r: any): { key: string | null; ok: boolean; pending: boolean; explicitNone: boolean } => {
    const k = r.hw_set_key as string | null;
    if (!k) return { key: null, ok: false, pending: false, explicitNone: false };
    const v = variantsOf(k);
    const pick = (t: string | null) => t === null ? { key: null, ok: false, pending: false, explicitNone: true }
      : (v.length ? v.includes(t) : setByKey.has(t)) ? { key: t, ok: true, pending: false, explicitNone: false }
      : { key: null, ok: false, pending: v.length > 0, explicitNone: false };
    if (res.row_sets && Object.hasOwn(res.row_sets, r.id)) return pick(res.row_sets[r.id]);
    if (res.set_map && Object.hasOwn(res.set_map, k)) return pick(res.set_map[k]);
    if (setByKey.has(k)) return { key: k, ok: true, pending: false, explicitNone: false };
    return { key: null, ok: false, pending: v.length > 0, explicitNone: false };
  };
  if (!imp.hardware_version_id) issues.push({ code: "no_hardware_schedule", severity: "info", message: "No hardware schedule was attached; only openings, leaves and frames are planned" });
  else {
    const refs = new Map<string, any[]>();
    for (const r of doorRows) if (r.hw_set_key && markOf.get(r.id)) (refs.get(r.hw_set_key) ?? refs.set(r.hw_set_key, []).get(r.hw_set_key)!).push(r);
    for (const [k, list] of refs) {
      const variants = variantsOf(k);
      if (variants.length) {
        const open = list.filter((x: any) => !duplicates.has(markOf.get(x.id)!) && rowSet(x).pending);
        issues.push({ code: "ambiguous_group", severity: open.length ? "blocker" : "info", key: k, variants, row_ids: list.map((x: any) => x.id), unresolved_row_ids: open.map((x: any) => x.id),
          message: open.length ? `Group ${k} has lettered variants (${variants.join(", ")}); choose the variant for each door (${open.length} still open) before confirming`
            : `Group ${k} has lettered variants (${variants.join(", ")}); a choice was made for every door` });
        continue;
      }
      const mapped = res.set_map && Object.hasOwn(res.set_map, k);
      if (mapped) { const t = res.set_map![k]; if (t !== null && !setByKey.has(t)) issues.push({ code: "unknown_group", severity: "warning", key: k, message: `Group ${k} is mapped to ${t}, which is not in the hardware schedule; these doors are imported without hardware and flagged for follow-up`, row_ids: list.map((x: any) => x.id) }); continue; }
      if (setByKey.has(k)) continue;
      issues.push({ code: "unknown_group", severity: "warning", key: k, message: `Group ${k} is not defined in the hardware schedule; these doors are imported without hardware and flagged for follow-up`, row_ids: list.map((x: any) => x.id) });
    }
    const varies = doorRows.filter((r: any) => (r.issues ?? []).some((i: any) => i.code === "hw_varies"));
    if (varies.length) issues.push({ code: "hw_varies", severity: "warning", message: `${varies.length} door(s) say <varies> for hardware; they are imported without hardware and flagged for follow-up`, row_ids: varies.map((r: any) => r.id) });
    const numeric = sets.map((s: any) => /^(\d+)(?:-|$)/.exec(s.set_key)).filter(Boolean).map((m: any) => parseInt(m[1], 10));
    if (numeric.length) {
      const have = new Set(numeric); const gaps: number[] = [];
      for (let n = Math.min(...numeric); n <= Math.max(...numeric); n++) if (!have.has(n)) gaps.push(n);
      if (gaps.length) issues.push({ code: "missing_set_numbers", severity: "warning", message: `Hardware schedule has no set ${gaps.join(", ")}` });
    }
    const others = sets.filter((s: any) => s.furnished_by_others);
    if (others.length) issues.push({ code: "furnished_by_others", severity: "info", message: `Set(s) ${others.map((s: any) => s.set_key).join(", ")} list no items (hardware furnished by others)` });
    const unmatched = items.filter((i: any) => i.needs_review);
    if (unmatched.length) issues.push({ code: "unmatched_items", severity: "warning", message: `${unmatched.length} hardware item(s) need review (unknown type or manufacturer); they are not applied unless accepted`, item_ids: unmatched.map((i: any) => i.id) });
    const referenced = new Set(doorRows.map((r: any) => rowSet(r).key).filter(Boolean));
    const unused = sets.filter((s: any) => !referenced.has(s.set_key)).map((s: any) => s.set_key);
    if (unused.length) issues.push({ code: "unreferenced_sets", severity: "info", message: `Set(s) ${unused.join(", ")} are not used by any door in this import` });
  }
  for (const r of doorRows) for (const i of r.issues ?? []) if (!["hw_varies", "hw_missing"].includes(i.code))
    issues.push({ code: i.code, severity: "warning", message: `Row ${r.source_row} (${r.door_mark_raw}): ${i.message}`, row_ids: [r.id] });

  // Current state of the chosen building.
  const openings = (await db.query("SELECT id, opening_code, schedule_door_mark, location_description, fire_rated, opening_configuration, completion_state FROM openings WHERE building_id=$1", [imp.building_id])).rows;
  const ids = openings.map((o: any) => o.id);
  const leaves = ids.length ? (await db.query("SELECT * FROM door_leaves WHERE opening_id = ANY($1::uuid[])", [ids])).rows : [];
  const frames = ids.length ? (await db.query("SELECT * FROM opening_frames WHERE opening_id = ANY($1::uuid[])", [ids])).rows : [];
  const hardware = ids.length ? (await db.query("SELECT * FROM hardware_components WHERE opening_id = ANY($1::uuid[]) AND lifecycle_state='active'", [ids])).rows : [];
  const effects = ids.length ? (await db.query("SELECT entity_id, item_signature FROM schedule_import_effects WHERE entity_type='hardware' AND action='create' AND item_signature IS NOT NULL AND entity_id IN (SELECT id FROM hardware_components WHERE opening_id = ANY($1::uuid[]))", [ids])).rows : [];
  const sigOf = new Map<string, string>(effects.map((e: any) => [e.entity_id, e.item_signature]));
  const byScheduleMark = new Map(openings.filter((o: any) => o.schedule_door_mark).map((o: any) => [o.schedule_door_mark, o]));
  const byCode = new Map(openings.filter((o: any) => !o.schedule_door_mark).map((o: any) => [normalizeMark(o.opening_code), o]));

  const plans: OpeningPlan[] = [];
  for (const r of doorRows) {
    const mark = markOf.get(r.id) ?? null;
    const base = { row_id: r.id, source_row: r.source_row, mark, opening_id: null, opening_code: null, set_key: null, fields: [], leaves: [], frame: null, hardware: [], variant_choice: null, follow_up: null } as Omit<OpeningPlan, "action">;
    if (!mark) { plans.push({ ...base, action: "skip", skip_reason: res.rows?.[r.id]?.skip ? "skipped_by_user" : "no_mark" }); continue; }
    if (duplicates.has(mark)) { plans.push({ ...base, action: "skip", skip_reason: "duplicate_mark" }); continue; }
    const existing: any = byScheduleMark.get(mark) ?? byCode.get(mark) ?? null;
    const config = configurationFor(r);
    const verifiedOpening = existing?.completion_state === "complete";
    const fields: FieldChange[] = [];
    const push = (c: FieldChange | null) => { if (c) fields.push(c); };
    const oid = existing?.id ?? null;
    if (existing && !existing.schedule_door_mark) push({ entity: "opening", entity_id: oid, field: "schedule_door_mark", from: null, to: mark, status: "fill", overwrite_key: null });
    push(change("opening", oid, "location_description", existing?.location_description, locationFor(r), verifiedOpening, overwrite));
    push(change("opening", oid, "fire_rated", existing?.fire_rated, r.fire_rating_minutes === null ? null : r.fire_rating_minutes > 0, verifiedOpening, overwrite));
    push(change("opening", oid, "opening_configuration", existing?.opening_configuration, config, verifiedOpening, overwrite));
    const leafRoles = config === "pair" ? ["active", "inactive"] : ["single"];
    const widths = scheduledLeafWidths(r, config === "pair");
    if (widths.estimated) issues.push({ code: "estimated_even_split", severity: "info", message: `Row ${r.source_row} (${mark}): pair width was split evenly because the schedule did not give two leaf widths`, row_ids: [r.id] });
    const widthFor = (role: string) => config === "pair" ? (role === "inactive" ? widths.inactive : widths.active) : num(r.width_in);
    const leafPlans: OpeningPlan["leaves"] = [];
    for (const role of leafRoles) {
      const leaf = leaves.find((l: any) => l.opening_id === oid && l.leaf_role === role) ?? null;
      const v = !!leaf && VERIFIED_CONDITIONS.has(leaf.condition);
      leafPlans.push({ role, id: leaf?.id ?? null, create: !leaf });
      for (const [f, val] of [["material", r.door_material], ["width_in", widthFor(role)], ["height_in", num(r.height_in)], ["thickness_in", num(r.thickness_in)], ["fire_rated", r.fire_rating_minutes === null ? null : r.fire_rating_minutes > 0]] as const) {
        const c = change("door_leaf", leaf?.id ?? null, f, leaf?.[f], val, v, overwrite);
        if (c) fields.push({ ...c, field: leaf ? f : `${role}.${f}` });
      }
    }
    const frame = frames.find((f: any) => f.opening_id === oid) ?? null;
    const frameVals = [["material", r.frame_material], ["width_in", num(r.width_in)], ["height_in", num(r.height_in)]] as const;
    let framePlan: OpeningPlan["frame"] = null;
    if (frame || frameVals.some(([, v]) => v !== null)) {
      framePlan = { id: frame?.id ?? null, create: !frame };
      for (const [f, val] of frameVals) push(change("frame", frame?.id ?? null, f, frame?.[f], val, !!frame && VERIFIED_CONDITIONS.has(frame.condition), overwrite));
    }
    // Hardware for the resolved set.
    const set = rowSet(r);
    const hwPlans: HardwarePlan[] = [];
    if (imp.hardware_version_id && set.ok && set.key) {
      const s = setByKey.get(set.key);
      const mine = hardware.filter((h: any) => h.opening_id === oid);
      for (const it of itemsBySet.get(s.id) ?? []) {
        const signature = `${s.set_key}#${it.position}`;
        const hp: HardwarePlan = { item_id: it.id, signature, description: it.description, item_type: it.item_type, component_type: it.component_type, qty: it.qty ?? null, action: "add", component_id: null, changes: [] };
        if (it.needs_review && !accepted.has(it.id)) { hwPlans.push({ ...hp, action: "needs_review" }); continue; }
        const prior = mine.find((h: any) => sigOf.get(h.id) === signature);
        if (prior) {
          const hv = prior.review_state === "reviewed" || prior.identity_status === "established" || VERIFIED_CONDITIONS.has(prior.condition);
          for (const [f, val] of [["manufacturer", it.manufacturer ?? it.manufacturer_raw], ["model_number", it.catalog], ["finish", it.finish], ["quantity", it.qty && it.qty > 0 ? it.qty : null]] as const) {
            const c = change("hardware", prior.id, f, prior[f], val, hv, overwrite); if (c) hp.changes.push(c);
          }
          const act = hp.changes.some(applies) ? "update" : hp.changes.some((c) => c.status === "protected") ? "protected" : "unchanged";
          hwPlans.push({ ...hp, action: act, component_id: prior.id }); continue;
        }
        const fieldOwned = it.component_type !== "other" && mine.find((h: any) => !sigOf.has(h.id) && h.component_type === it.component_type);
        if (fieldOwned) { hwPlans.push({ ...hp, action: "field_present", component_id: fieldOwned.id }); continue; }
        hwPlans.push(hp);
      }
    }
    let follow_up: FollowUp | null = null;
    const variants = r.hw_set_key ? variantsOf(r.hw_set_key) : [];
    const variant_choice = imp.hardware_version_id && variants.length ? { group: r.hw_set_key, options: variants, chosen: set.ok ? set.key : null, pending: set.pending } : null;
    if (imp.hardware_version_id && !set.ok && !set.pending) {
      const k = r.hw_set_key as string | null;
      if ((r.issues ?? []).some((i: any) => i.code === "hw_varies")) follow_up = { reason: "hw_varies", detail: r.hw_ref_raw ?? null };
      else if (k === "X") follow_up = { reason: "hw_group_x", detail: r.hw_ref_raw ?? null };
      else if (k && variants.length) follow_up = { reason: "hw_variant_none", detail: r.hw_ref_raw ?? null };
      else if (k && setByKey.has(k)) follow_up = { reason: "hw_none_chosen", detail: r.hw_ref_raw ?? null };
      else if (k) follow_up = { reason: "hw_group_undefined", detail: r.hw_ref_raw ?? null };
      else follow_up = { reason: "hw_missing", detail: null }; // blank hardware column: treated like Group X
    }
    const any = fields.some(applies) || leafPlans.some((l) => l.create) || !!framePlan?.create || hwPlans.some((h) => h.action === "add" || h.action === "update");
    plans.push({ ...base, action: existing ? (any ? "update" : "unchanged") : "create", opening_id: oid, opening_code: existing?.opening_code ?? null,
      set_key: set.ok ? set.key : null, fields, leaves: leafPlans, frame: framePlan, hardware: hwPlans, variant_choice, follow_up });
  }
  const protectedCount = plans.reduce((n, p) => n + p.fields.filter((f) => f.status === "protected").length + p.hardware.reduce((m, h) => m + h.changes.filter((c) => c.status === "protected").length, 0), 0);
  if (protectedCount) issues.push({ code: "field_verified_protected", severity: "warning", message: `${protectedCount} field-verified value(s) differ from the schedule and will be kept unless you confirm each overwrite` });
  const summary = {
    door_rows: doorRows.length, type_template_rows: templates.length,
    create_openings: plans.filter((p) => p.action === "create").length,
    update_openings: plans.filter((p) => p.action === "update").length,
    unchanged_openings: plans.filter((p) => p.action === "unchanged").length,
    skipped_rows: plans.filter((p) => p.action === "skip").length,
    add_hardware: plans.reduce((n, p) => n + p.hardware.filter((h) => h.action === "add").length, 0),
    update_hardware: plans.reduce((n, p) => n + p.hardware.filter((h) => h.action === "update").length, 0),
    hardware_needing_review: plans.reduce((n, p) => n + p.hardware.filter((h) => h.action === "needs_review").length, 0),
    protected_fields: protectedCount,
    follow_up_rows: plans.filter((p) => p.follow_up).length,
    variant_choices_pending: plans.filter((p) => p.variant_choice?.pending).length,
  };
  return { issues, openings: plans, summary, blocked: issues.some((i) => i.severity === "blocker") };
}

type BulkRow = Record<string, unknown>;
const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return `"${s}"`; };

/** One multi-row INSERT; column types come from the table's own row type. */
async function bulkInsert(db: Db, table: string, cols: string[], rows: BulkRow[]) {
  if (!rows.length) return;
  const c = cols.map(ident).join(", ");
  await db.query(`INSERT INTO ${ident(table)}(${c}) SELECT ${c} FROM jsonb_populate_recordset(NULL::${ident(table)}, $1::jsonb)`, [JSON.stringify(rows)]);
}

/** One multi-row UPDATE of a single column; the value is typed through the table's row type. */
async function bulkUpdate(db: Db, table: string, field: string, rows: { id: string; v: unknown }[], revision: boolean) {
  if (!rows.length) return;
  const f = ident(field), t = ident(table);
  await db.query(`UPDATE ${t} AS t SET ${f} = (jsonb_populate_record(NULL::${t}, jsonb_build_object('${field}', x.v))).${f}${revision ? ", revision = t.revision + 1, updated_at = now()" : ""}
    FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, v jsonb) WHERE t.id = x.id`, [JSON.stringify(rows.map((r) => ({ id: r.id, v: r.v === undefined ? null : r.v })))]);
}

/** Reserve opening codes for every new opening with a single lookup (same naming as before: base, base-2 .. base-50, then random). */
async function reserveOpeningCodes(db: Db, buildingId: string, marks: string[]): Promise<string[]> {
  if (!marks.length) return [];
  const bases = marks.map((m) => `${m}-${buildingId.replace(/-/g, "").slice(0, 6).toUpperCase()}`.slice(0, 60));
  const candidates = [...new Set(bases.flatMap((b) => Array.from({ length: 50 }, (_, n) => (n ? `${b}-${n + 1}` : b))))];
  const taken = new Set<string>((await db.query("SELECT opening_code FROM openings WHERE opening_code = ANY($1::text[])", [candidates])).rows.map((r: any) => r.opening_code));
  return bases.map((base) => {
    for (let n = 0; n < 50; n++) { const code = n ? `${base}-${n + 1}` : base; if (!taken.has(code)) { taken.add(code); return code; } }
    const code = `${base}-${randomBytes(3).toString("hex").toUpperCase()}`; taken.add(code); return code;
  });
}

/**
 * Apply a plan inside the caller's transaction. Inserts and updates only; nothing is deleted.
 * All writes are batched: one statement per table (plus one per updated column), so a full schedule
 * confirms in a fixed, small number of round trips instead of one per row/field.
 */
export async function applyPlan(db: Db, imp: any, loaded: NonNullable<Awaited<ReturnType<typeof loadImport>>>, plan: ImportPlan) {
  const rowById = new Map(loaded.rows.map((r: any) => [r.id, r]));
  const itemById = new Map(loaded.items.map((i: any) => [i.id, i]));
  const counts = { follow_ups: 0, openings_created: 0, openings_updated: 0, leaves_created: 0, frames_created: 0, fields_written: 0, hardware_added: 0, hardware_updated: 0, protected_kept: 0 };
  const ins = { openings: [] as BulkRow[], door_leaves: [] as BulkRow[], opening_frames: [] as BulkRow[], hardware_components: [] as BulkRow[] };
  const effects: BulkRow[] = [], followUps: BulkRow[] = [];
  // table.field -> batches; an id appears at most once per batch so repeated writes keep their order.
  const updates = new Map<string, { table: string; field: string; revision: boolean; batches: { ids: Set<string>; rows: { id: string; v: unknown }[] }[] }>();
  const update = (table: string, field: string, id: string, v: unknown, revision: boolean) => {
    const k = `${table}.${field}`;
    let u = updates.get(k); if (!u) updates.set(k, u = { table, field, revision, batches: [] });
    let b = u.batches.find((x) => !x.ids.has(id)); if (!b) u.batches.push(b = { ids: new Set(), rows: [] });
    b.ids.add(id); b.rows.push({ id, v });
  };
  const effect = (entity: string, id: string, action: string, field: string | null, oldV: unknown, newV: unknown, sig: string | null = null) => {
    effects.push({ id: randomUUID(), import_id: imp.id, entity_type: entity, entity_id: id, action, field,
      old_value: oldV === undefined ? null : JSON.stringify(oldV), new_value: newV === undefined ? null : JSON.stringify(newV), item_signature: sig });
  };
  const followUp = (p: OpeningPlan, openingId: string | null) => {
    if (!p.follow_up || !openingId) return;
    followUps.push({ id: randomUUID(), import_id: imp.id, row_id: p.row_id, opening_id: openingId, reason: p.follow_up.reason, detail: p.follow_up.detail });
    counts.follow_ups++;
  };
  const newOpenings = plan.openings.filter((p) => p.action !== "skip" && p.action !== "unchanged" && !p.opening_id);
  const codes = await reserveOpeningCodes(db, imp.building_id, newOpenings.map((p) => p.mark!));
  const codeFor = new Map(newOpenings.map((p, i) => [p, codes[i]]));
  for (const p of plan.openings) {
    if (p.action === "skip") continue;
    if (p.action === "unchanged") { counts.protected_kept += p.fields.filter((f) => f.status === "protected").length; followUp(p, p.opening_id); continue; }
    const r: any = rowById.get(p.row_id);
    let openingId = p.opening_id;
    const val = (entity: string, field: string) => p.fields.find((f) => f.entity === entity && f.field === field && applies(f))?.to;
    if (!openingId) {
      openingId = randomUUID();
      const code = codeFor.get(p)!;
      const fire = val("opening", "fire_rated");
      ins.openings.push({ id: openingId, opening_code: code, building_id: imp.building_id, location_description: val("opening", "location_description") ?? null, opening_type: "door",
        fire_rated: fire ?? false, qr_token: randomUUID(), status: "pending_capture", opening_configuration: val("opening", "opening_configuration") ?? "single", schedule_door_mark: p.mark });
      effect("opening", openingId, "create", null, null, { opening_code: code, schedule_door_mark: p.mark, source_row: r.source_row });
      counts.openings_created++;
    } else {
      const set = p.fields.filter((f) => f.entity === "opening" && applies(f));
      for (const f of set) { update("openings", f.field, openingId, f.to, true); effect("opening", openingId, "update", f.field, f.from, f.to); counts.fields_written++; }
      if (set.length || p.action === "update") counts.openings_updated++;
    }
    for (const l of p.leaves) {
      if (l.create) {
        const id = randomUUID();
        const g = (f: string) => p.fields.find((x) => x.entity === "door_leaf" && x.entity_id === null && x.field === `${l.role}.${f}`)?.to ?? null;
        ins.door_leaves.push({ id, opening_id: openingId, leaf_role: l.role, material: g("material"), width_in: g("width_in"), height_in: g("height_in"), thickness_in: g("thickness_in"), fire_rated: g("fire_rated") ?? false, condition: "unverified" });
        effect("door_leaf", id, "create", null, null, { leaf_role: l.role }); counts.leaves_created++;
      } else for (const f of p.fields.filter((x) => x.entity === "door_leaf" && x.entity_id === l.id && applies(x))) {
        update("door_leaves", f.field, l.id!, f.to, true); effect("door_leaf", l.id!, "update", f.field, f.from, f.to); counts.fields_written++;
      }
    }
    if (p.frame?.create) {
      const id = randomUUID();
      const g = (f: string) => p.fields.find((x) => x.entity === "frame" && x.entity_id === null && x.field === f)?.to ?? null;
      ins.opening_frames.push({ id, opening_id: openingId, material: g("material"), width_in: g("width_in"), height_in: g("height_in"), fire_rated: r.fire_rating_minutes > 0, condition: "unverified" });
      effect("frame", id, "create", null, null, {}); counts.frames_created++;
    } else if (p.frame?.id) for (const f of p.fields.filter((x) => x.entity === "frame" && applies(x))) {
      update("opening_frames", f.field, p.frame.id, f.to, true); effect("frame", p.frame.id, "update", f.field, f.from, f.to); counts.fields_written++;
    }
    for (const h of p.hardware) {
      const it: any = itemById.get(h.item_id);
      if (h.action === "add") {
        const id = randomUUID();
        const notes = [`From schedule import ${imp.id}, set ${h.signature.split("#")[0]}, qty ${it.qty ?? "?"}`,
          it.item_type !== it.component_type ? `type: ${it.item_type}` : null, it.furnished_by, it.options ? `options: ${it.options}` : null,
          it.finish_bhma ? `BHMA ${it.finish_bhma}` : null].filter(Boolean).join("; ");
        ins.hardware_components.push({ id, opening_id: openingId, component_type: it.component_type, manufacturer: it.manufacturer ?? it.manufacturer_raw ?? null, model_number: it.catalog ?? null, finish: it.finish ?? null,
          notes: notes.slice(0, 2000), tracker_id: `TRK-${randomBytes(4).toString("hex").toUpperCase()}`, mounting_scope: "opening", position_label: it.description.slice(0, 120),
          condition: "unverified", identity_status: "unresolved", review_state: "pending", quantity: it.qty && it.qty > 0 ? it.qty : null });
        effect("hardware", id, "create", null, null, { item_id: it.id, description: it.description }, h.signature); counts.hardware_added++;
      } else if (h.action === "update" && h.component_id) {
        for (const c of h.changes.filter(applies)) { update("hardware_components", c.field, h.component_id, c.to, false); effect("hardware", h.component_id, "update", c.field, c.from, c.to, h.signature); }
        counts.hardware_updated++;
      }
    }
    followUp(p, openingId);
    counts.protected_kept += p.fields.filter((f) => f.status === "protected").length + p.hardware.reduce((m, h) => m + h.changes.filter((c) => c.status === "protected").length, 0);
  }
  // Parents before children (foreign keys), then field updates, then the effect ledger and follow-ups.
  await bulkInsert(db, "openings", ["id", "opening_code", "building_id", "location_description", "opening_type", "fire_rated", "qr_token", "status", "opening_configuration", "schedule_door_mark"], ins.openings);
  await bulkInsert(db, "door_leaves", ["id", "opening_id", "leaf_role", "material", "width_in", "height_in", "thickness_in", "fire_rated", "condition"], ins.door_leaves);
  await bulkInsert(db, "opening_frames", ["id", "opening_id", "material", "width_in", "height_in", "fire_rated", "condition"], ins.opening_frames);
  await bulkInsert(db, "hardware_components", ["id", "opening_id", "component_type", "manufacturer", "model_number", "finish", "notes", "tracker_id", "mounting_scope", "position_label", "condition", "identity_status", "review_state", "quantity"], ins.hardware_components);
  for (const u of updates.values()) for (const b of u.batches) await bulkUpdate(db, u.table, u.field, b.rows, u.revision);
  if (effects.length) await db.query(`INSERT INTO schedule_import_effects(id,import_id,entity_type,entity_id,action,field,old_value,new_value,item_signature)
    SELECT id, import_id, entity_type, entity_id, action, field, old_value::jsonb, new_value::jsonb, item_signature
    FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, import_id uuid, entity_type text, entity_id uuid, action text, field text, old_value text, new_value text, item_signature text)`, [JSON.stringify(effects)]);
  if (followUps.length) await db.query(`INSERT INTO schedule_row_follow_ups(id, import_id, row_id, opening_id, reason, detail)
    SELECT id, import_id, row_id, opening_id, reason, detail FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, import_id uuid, row_id uuid, opening_id uuid, reason text, detail text)`, [JSON.stringify(followUps)]);
  return counts;
}
