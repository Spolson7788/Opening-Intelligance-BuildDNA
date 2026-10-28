// t97 item 1: facility area filter for the field app picker. The process name is the
// "California branch default": a tech's list starts on their home area (their branch's
// default territory/state, else their own home territory/state, which the server returns as
// preferences), and "All authorized facilities" is always one tap away so customers in
// other states stay reachable. This only narrows the list the server already authorized;
// it is never an access control.
import type { FacilityProperty } from "./facilityOpenings";

export type AreaFilter = { kind: "all" } | { kind: "state"; value: string } | { kind: "territory"; value: string };
export interface AreaPreferences { home_state?: string | null; home_territory?: string | null }
export const ALL_AREAS: AreaFilter = { kind: "all" };
export const areaFilterKey = (p: { userId: string; organizationId: string }) => `facility-area:${p.userId}:${p.organizationId}`;

const norm = (v: unknown) => String(v ?? "").trim().toUpperCase();
export function facilityInArea(f: FacilityProperty, a: AreaFilter): boolean {
  if (a.kind === "all") return true;
  if (a.kind === "state") return norm(f.state) === norm(a.value);
  return (f.service_territory ?? "") === a.value;
}
/** Narrow the authorized list. The currently selected facility always stays visible. */
export function filterFacilitiesByArea(list: FacilityProperty[], a: AreaFilter, keepId?: string | null): FacilityProperty[] {
  return list.filter((f) => f.id === keepId || facilityInArea(f, a));
}
/** Home area if it matches at least one authorized facility; territory first, then state; else All. */
export function defaultAreaFilter(prefs: AreaPreferences | null | undefined, list: FacilityProperty[]): AreaFilter {
  const t = prefs?.home_territory?.trim();
  if (t && list.some((f) => f.service_territory === t)) return { kind: "territory", value: t };
  const s = norm(prefs?.home_state);
  if (s && list.some((f) => norm(f.state) === s)) return { kind: "state", value: s };
  return ALL_AREAS;
}
export function areaOptions(list: FacilityProperty[]) {
  return {
    states: [...new Set(list.map((f) => norm(f.state)).filter(Boolean))].sort(),
    territories: [...new Set(list.map((f) => f.service_territory ?? "").filter(Boolean))].sort(),
  };
}
export const sameArea = (a: AreaFilter, b: AreaFilter) => a.kind === b.kind && (a.kind === "all" || (a as any).value === (b as any).value);
export const areaLabel = (a: AreaFilter) => a.kind === "all" ? "All authorized facilities" : a.kind === "state" ? `State ${a.value}` : `Territory ${a.value}`;
