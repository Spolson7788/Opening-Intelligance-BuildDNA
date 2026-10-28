import { normalizeMark } from "./scheduleParsing/normalize";

// M4: compare what a confirmed schedule import said (immutable schedule_rows /
// schedule_set_items / schedule_import_effects) with the current field state of
// the import's building. Pure read: this module never writes. Snapshots store
// its output (see routes/scheduleComparisons.ts).
type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export const COMPARISON_ENGINE_VERSION = 1;
export const COMPARISON_CATEGORIES = ["scheduled_not_surveyed", "scheduled_opening_missing", "not_in_schedule", "field_mismatch", "hardware_difference", "open_follow_up"] as const;
export type ComparisonCategory = typeof COMPARISON_CATEGORIES[number];
export type OpeningStatus = "matched" | "differences" | "not_surveyed" | "missing" | "not_in_schedule";

/** One difference (one CSV line). */
export type ComparisonLine = {
  category: ComparisonCategory; mark: string | null; opening_id: string | null; opening_code: string | null;
  entity: "opening" | "door_leaf" | "frame" | "hardware" | "schedule_row" | "follow_up"; field: string | null;
  schedule_value: string | null; field_value: string | null; note: string | null;
};
export type ComparisonOpening = {
  mark: string | null; source_row: number | null; opening_id: string | null; opening_code: string | null; floor_label: string | null;
  match: "mark" | "code" | null; surveyed: boolean; surveyed_at: string | null; surveyed_by_role: string | null;
  status: OpeningStatus; set_key: string | null; lines: ComparisonLine[];
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

export async function compareImport(db: Db, importId: string): Promise<ComparisonResult | null> {
  const imp = (await db.query("SELECT * FROM schedule_imports WHERE id=$1", [importId])).rows[0];
  if (!imp) return null;
  const res = imp.resolutions ?? {};
  const rows = (await db.query("SELECT * FROM schedule_rows WHERE import_id=$1 AND row_kind='door' ORDER BY source_sheet, source_row", [importId])).rows;
  const sets = (await db.query("SELECT id, set_key FROM schedule_hardware_sets WHERE import_id=$1", [importId])).rows;
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
  const setKeys = new Set<string>(sets.map((s: any) => s.set_key)), setIdOf = new Map(sets.map((s: any) => [s.set_key, s.id]));
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
  const byCode = new Map<string, any>(); for (const o of openings) if (!o.schedule_door_mark) { const c = normalizeMark(o.opening_code); if (c && !byCode.has(c)) byCode.set(c, o); }
  const used = new Set<string>();
  const out: ComparisonOpening[] = [];

  for (const r of rows) {
    const mark = markOf.get(r.id) ?? null;
    const base = { mark: mark ?? r.door_mark ?? r.door_mark_raw ?? null, source_row: r.source_row, set_key: null as string | null };
    const missing = (note: string, o: any = null) => out.push({ ...base, opening_id: o?.id ?? null, opening_code: o?.opening_code ?? null, floor_label: o?.floor_label ?? null, match: o ? "mark" : null,
      surveyed: false, surveyed_at: null, surveyed_by_role: null, status: "missing",
      lines: [{ category: "scheduled_opening_missing", mark: base.mark, opening_id: o?.id ?? null, opening_code: o?.opening_code ?? null, entity: "schedule_row", field: null, schedule_value: `row ${r.source_row}`, field_value: null, note }] });
    if (!mark) { missing(res.rows?.[r.id]?.skip ? "skipped_by_user" : "no_mark"); continue; }
    if ((count.get(mark) ?? 0) > 1) { missing("duplicate_mark"); continue; }
    let o: any = byMark.get(mark), match: "mark" | "code" = "mark";
    if (!o) { o = byCode.get(mark); match = "code"; }
    if (!o || used.has(o.id)) { missing("no_opening"); continue; }
    used.add(o.id);
    if (o.status === "decommissioned") { missing("decommissioned", o); continue; }
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
    for (const l of leavesOf.get(o.id) ?? []) if (VERIFIED.has(l.condition)) {
      const w = blank(r.width_in) ? null : pair ? Number(r.width_in) / 2 : Number(r.width_in);
      cmpText("door_leaf", `${l.leaf_role}.material`, r.door_material, l.material);
      cmpNum("door_leaf", `${l.leaf_role}.width_in`, w, l.width_in, pair ? "pair: schedule width / 2" : null);
      cmpNum("door_leaf", `${l.leaf_role}.height_in`, r.height_in, l.height_in);
      cmpNum("door_leaf", `${l.leaf_role}.thickness_in`, r.thickness_in, l.thickness_in);
      cmpBool("door_leaf", `${l.leaf_role}.fire_rated`, fire, l.fire_rated);
    }
    for (const f of framesOf.get(o.id) ?? []) if (VERIFIED.has(f.condition)) {
      cmpText("frame", "material", r.frame_material, f.material);
      cmpNum("frame", "width_in", r.width_in, f.width_in); cmpNum("frame", "height_in", r.height_in, f.height_in);
    }
    // Hardware: scheduled items vs active components.
    const mine = hwOf.get(o.id) ?? [];
    const taken = new Set<string>();
    const expected = setKey ? itemsOf.get(setIdOf.get(setKey) as string) ?? [] : [];
    for (const it of expected) {
      const sig = `${setKey}#${it.position}`;
      let h = mine.find((x) => !taken.has(x.id) && sigOf.get(x.id) === sig);
      let how = "schedule";
      if (!h && it.component_type !== "other") { h = mine.find((x) => !taken.has(x.id) && !sigOf.has(x.id) && x.component_type === it.component_type); how = "field-owned"; }
      const label = `${sig} ${it.description}`.slice(0, 200);
      if (!h) { line("hardware_difference", "hardware", label, `${it.component_type}${it.qty ? " x" + it.qty : ""}`, null, "scheduled item not found in field"); continue; }
      taken.add(h.id);
      if (!hwVerified(h)) continue;
      const note = how === "field-owned" ? "field-owned (matched by type)" : null;
      const diff = (f: string, sv: unknown, fv: unknown) => { if (!blank(sv) && !blank(fv) && (f === "quantity" ? Number(sv) !== Number(fv) : text(sv) !== text(fv))) line("hardware_difference", "hardware", `${label} ${f}`, sv, fv, note); };
      diff("manufacturer", it.manufacturer ?? it.manufacturer_raw, h.manufacturer); diff("model_number", it.catalog, h.model_number);
      diff("finish", it.finish, h.finish); diff("quantity", it.qty && it.qty > 0 ? it.qty : null, h.quantity);
      if (h.condition === "failed") line("hardware_difference", "hardware", label, "installed", "failed", "verified failed: needs replacement");
    }
    for (const h of mine) if (!taken.has(h.id)) line("hardware_difference", "hardware", `${h.component_type}${h.position_label ? " " + h.position_label : ""}`.slice(0, 200), null,
      [h.component_type, h.manufacturer, h.model_number].filter(Boolean).join(" "), "field hardware not in schedule");
    const diffs = lines.some((x) => x.category === "field_mismatch" || x.category === "hardware_difference");
    out.push({ ...base, mark, opening_id: o.id, opening_code: o.opening_code, floor_label: o.floor_label, match, ...s, status: diffs ? "differences" : "matched", set_key: setKey, lines });
  }
  for (const o of openings) if (!used.has(o.id)) {
    const s = survey(o);
    out.push({ mark: o.schedule_door_mark ?? null, source_row: null, opening_id: o.id, opening_code: o.opening_code, floor_label: o.floor_label, match: null, ...s, status: "not_in_schedule", set_key: null,
      lines: [{ category: "not_in_schedule", mark: o.schedule_door_mark ?? null, opening_id: o.id, opening_code: o.opening_code, entity: "opening", field: null, schedule_value: null,
        field_value: o.opening_code, note: s.surveyed ? "surveyed" : "not surveyed" }] });
  }
  const all = out.flatMap((x) => x.lines);
  const summary: Record<string, number> = {
    schedule_rows: rows.length, live_openings: openings.length,
    matched_by_mark: out.filter((x) => x.source_row !== null && x.match === "mark" && x.status !== "missing").length,
    matched_by_code: out.filter((x) => x.match === "code").length,
    surveyed: out.filter((x) => x.source_row !== null && x.surveyed).length,
    openings_matched: out.filter((x) => x.status === "matched").length,
    openings_with_differences: out.filter((x) => x.status === "differences").length,
    lines: all.length,
  };
  for (const c of COMPARISON_CATEGORIES) summary[c] = all.filter((l) => l.category === c).length;
  return { summary, openings: out };
}

export const CSV_COLUMNS = ["import_id", "building", "mark", "opening_code", "match", "category", "entity", "field", "schedule_value", "field_value", "surveyed", "surveyed_by_role", "surveyed_at", "note"] as const;

/** Spreadsheet-safe cell: formula guard (= + - @ tab CR get a leading '), then RFC 4180 quoting. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function comparisonCsv(importId: string, building: string, result: { openings: ComparisonOpening[] }): string {
  const out = [CSV_COLUMNS.join(",")];
  for (const o of result.openings) for (const l of o.lines)
    out.push([importId, building, l.mark, l.opening_code, o.match === "code" ? "matched by code" : o.match ?? "", l.category, l.entity, l.field, l.schedule_value, l.field_value,
      o.surveyed ? "yes" : "no", o.surveyed_by_role, o.surveyed_at, l.note].map(csvCell).join(","));
  return out.join("\r\n") + "\r\n";
}