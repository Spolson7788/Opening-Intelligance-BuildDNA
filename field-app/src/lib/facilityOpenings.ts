// M4 v2: facility openings in the field app (pure helpers, testable).
// The API already scopes /openings?building_id= to the caller's organization: the
// facility owner org, or a provider org with an active facility assignment. Openings
// created by a confirmed schedule import are ordinary openings, so they are listed
// here exactly like hand-made ones; edits go through the existing opening screens and
// offline queue, so they sync back under the existing rules.
export interface FacilityOpening {
  id: string; opening_code: string; schedule_door_mark?: string | null; floor_label?: string | null; location_description?: string | null;
  completion_state?: string | null; status?: string | null; opening_configuration?: string | null; fire_rated?: boolean | null;
}
export interface FacilityBuilding { id: string; name: string }
export interface FacilityProperty { id: string; name: string; city?: string | null; state?: string | null; state_code?: string | null; county_fips?: string | null; state_name?: string | null; county_name?: string | null; service_territory?: string | null; buildings?: FacilityBuilding[] }

/** Loose search key: case, punctuation, spaces and leading zeros ignored ("Door 101-A" ~ "101a"). */
export function searchKey(v: unknown): string {
  return String(v ?? "").toUpperCase().replace(/^\s*(DOOR|DR|OPENING)(?=[\s.#:_\-]|\d)[\s.#:_\-]*/, "")
    .replace(/[^A-Z0-9]+/g, " ").trim().split(" ").map((t) => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t)).join("");
}
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortFacilityOpenings(list: FacilityOpening[]): FacilityOpening[] {
  return [...list].sort((a, b) => natural.compare(a.floor_label ?? "", b.floor_label ?? "")
    || natural.compare(a.schedule_door_mark ?? a.opening_code, b.schedule_door_mark ?? b.opening_code) || a.id.localeCompare(b.id));
}
export function filterFacilityOpenings(list: FacilityOpening[], q: string, onlyToSurvey = false): FacilityOpening[] {
  const k = searchKey(q);
  return list.filter((o) => (!onlyToSurvey || o.completion_state !== "complete")
    && (!k || [o.opening_code, o.schedule_door_mark, o.location_description].some((v) => searchKey(v).includes(k))));
}
export const facilityOpeningsCacheKey = (p: { userId: string; organizationId: string }, buildingId: string) => `facility-openings:${p.userId}:${p.organizationId}:${buildingId}`;
export const COMPARISON_REPORT_ROLES = ["admin", "facilities_manager", "technician", "inspector"];
export const comparisonReportHref = (base = "/dashboard") => `${base}/schedule-comparisons`;

/** Save each opening (full detail) on the device so it is available offline. Never throws. */
export async function prefetchOpenings(ids: string[], fetchOne: (id: string) => Promise<unknown>, concurrency = 3,
  onProgress?: (done: number, total: number) => void): Promise<{ saved: number; failed: number }> {
  let next = 0, saved = 0, failed = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { await fetchOne(id); saved++; } catch { failed++; }
      onProgress?.(saved + failed, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return { saved, failed };
}