// M3B: schedule type correction helpers shared by the schedule routes.

export type ScheduleKind = "door" | "hardware";

/** Same rule as the dashboard upload picker: .docx is a hardware schedule, spreadsheets/CSV are door schedules. */
export function kindForFilename(name: string): ScheduleKind | null {
  const ext = (name.toLowerCase().split(".").pop() ?? "").trim();
  if (ext === "docx") return "hardware";
  if (ext === "xlsx" || ext === "csv" || ext === "xls") return "door";
  return null;
}

/** True when the file looks like the other type (warning only, never a block). */
export function kindMismatch(kind: ScheduleKind, filename: string): boolean {
  const guess = kindForFilename(filename);
  return guess !== null && guess !== kind;
}

type Q = { query: (s: string, a?: unknown[]) => Promise<{ rows: any[] }> };

// A draft import is stale when a schedule it uses changed type after the draft
// was started. Derived from facility_schedule_events; schedule_imports is untouched.
export const STALE_IMPORT_SQL = `EXISTS (SELECT 1 FROM facility_schedule_versions sv JOIN facility_schedule_events se ON se.schedule_id=sv.schedule_id
  WHERE sv.id IN (i.door_version_id, i.hardware_version_id) AND se.event='kind_changed' AND se.created_at >= i.created_at)`;

// The code can ship before migration 20261028120000 is applied: until the event
// table and archive columns exist, lists behave exactly as before and the new
// endpoints answer 503. A positive result is cached; a negative one is re-checked.
let enabled = false;
export async function correctionsEnabled(db: Q): Promise<boolean> {
  if (enabled) return true;
  const r = await db.query(`SELECT to_regclass('public.facility_schedule_events') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='facility_schedules' AND column_name='archived_at') AS ok`);
  enabled = Boolean(r.rows[0]?.ok);
  return enabled;
}

export async function isImportStale(db: Q, importId: string): Promise<boolean> {
  if (!(await correctionsEnabled(db))) return false;
  const r = await db.query(`SELECT i.status='draft' AND ${STALE_IMPORT_SQL} AS stale FROM schedule_imports i WHERE i.id=$1`, [importId]);
  return Boolean(r.rows[0]?.stale);
}