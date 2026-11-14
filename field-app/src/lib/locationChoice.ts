import type { FacilityProperty } from "./facilityOpenings";
import { loginReturnPath } from "./qrPayload";
import { techTasksEnabled } from "./techTasks";

export interface AreaOption { key: string; label: string }
export interface LocationDraft { stateKey: string | null; countyKey: string | null; facilityId: string }

const UNSET = "__unset__";
export const confirmationKey = (principal: { userId: string; organizationId: string }) =>
  `location-confirmed:${principal.userId}:${principal.organizationId}`;

export function optionValue(key: string): string { return key === "" ? UNSET : key; }
export function keyFromOption(value: string): string | null {
  if (!value) return null;
  return value === UNSET ? "" : value;
}

export function stateKey(facility: FacilityProperty): string {
  return String(facility.state_code || facility.state || "").trim().toUpperCase();
}
export function stateLabel(facility: FacilityProperty): string {
  if (!stateKey(facility)) return "State not set";
  return facility.state_name || facility.state || stateKey(facility);
}
export function countyKey(facility: FacilityProperty): string {
  return String(facility.county_fips || "").trim();
}
export function countyLabel(facility: FacilityProperty): string {
  if (!countyKey(facility)) return "County not set";
  return facility.county_name || countyKey(facility);
}

export function statesFrom(list: FacilityProperty[]): AreaOption[] {
  const labels = new Map<string, string>();
  for (const facility of list) if (!labels.has(stateKey(facility))) labels.set(stateKey(facility), stateLabel(facility));
  return [...labels].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => ({ key, label }));
}
export function countiesFrom(list: FacilityProperty[], state: string | null): AreaOption[] {
  if (state === null) return [];
  const labels = new Map<string, string>();
  for (const facility of list) {
    if (stateKey(facility) !== state || labels.has(countyKey(facility))) continue;
    labels.set(countyKey(facility), countyLabel(facility));
  }
  return [...labels].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => ({ key, label }));
}
export function facilitiesFrom(list: FacilityProperty[], state: string | null, county: string | null): FacilityProperty[] {
  if (state === null || county === null) return [];
  return list.filter((facility) => stateKey(facility) === state && countyKey(facility) === county)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function describeLocation(list: FacilityProperty[], facilityId: string): string {
  const facility = list.find((item) => item.id === facilityId);
  if (!facility) return "";
  return `${facility.name} — ${stateLabel(facility)}, ${countyLabel(facility)}`;
}

export function initialDraft(list: FacilityProperty[], preferredId?: string | null): LocationDraft {
  const preferred = preferredId && list.some((facility) => facility.id === preferredId) ? preferredId : "";
  if (preferred) {
    const facility = list.find((item) => item.id === preferred)!;
    return { stateKey: stateKey(facility), countyKey: countyKey(facility), facilityId: preferred };
  }
  return narrowDraft(list, { stateKey: null, countyKey: null, facilityId: "" }, "state");
}

export function narrowDraft(list: FacilityProperty[], draft: LocationDraft, changed: "state" | "county" | "facility"): LocationDraft {
  const states = statesFrom(list);
  let stateKeyValue = draft.stateKey;
  if (states.length === 1) stateKeyValue = states[0].key;
  else if (stateKeyValue !== null && !states.some((item) => item.key === stateKeyValue)) stateKeyValue = null;
  const counties = countiesFrom(list, stateKeyValue);
  let countyKeyValue = changed === "state" ? null : draft.countyKey;
  if (counties.length === 1) countyKeyValue = counties[0].key;
  else if (countyKeyValue !== null && !counties.some((item) => item.key === countyKeyValue)) countyKeyValue = null;
  const facilities = facilitiesFrom(list, stateKeyValue, countyKeyValue);
  let facilityId = changed === "facility" ? draft.facilityId : (changed === "state" || changed === "county" ? "" : draft.facilityId);
  if (facilities.length === 1) facilityId = facilities[0].id;
  else if (!facilities.some((facility) => facility.id === facilityId)) facilityId = "";
  return { stateKey: stateKeyValue, countyKey: countyKeyValue, facilityId };
}

export function readLocationConfirmation(storage: Storage | null, principal: { userId: string; organizationId: string } | null): string | null {
  if (!storage || !principal) return null;
  try {
    const value = storage.getItem(confirmationKey(principal));
    return value && value.length <= 80 ? value : null;
  } catch { return null; }
}
export function writeLocationConfirmation(storage: Storage | null, principal: { userId: string; organizationId: string }, facilityId: string) {
  if (!storage || !facilityId) return;
  try { storage.setItem(confirmationKey(principal), facilityId); } catch { /* confirmation stays unconfirmed */ }
}
export function clearLocationConfirmation(storage: Storage | null, principal: { userId: string; organizationId: string } | null) {
  if (!storage || !principal) return;
  try { storage.removeItem(confirmationKey(principal)); } catch { /* sign-out still proceeds */ }
}

export function isDirectOpeningPath(path: string): boolean {
  return path.startsWith("/opening/");
}

export function scanNeedsChooser(principal: { userId: string; organizationId: string } | null, storage: Storage | null): boolean {
  return !readLocationConfirmation(storage, principal);
}

/** Where sign-in goes. Tech tasks skip Choose a location. A specific door link is unchanged. */
export function homeAfterSignIn(tasksOn: boolean, from: unknown, confirmed: boolean): string {
  const path = loginReturnPath(from);
  if (isDirectOpeningPath(path)) return path;
  if (tasksOn && (path === "/scan" || path === "/tasks/day" || path === "/choose-location")) return "/tasks/day";
  if (path === "/scan" || path === "/tasks/day") return confirmed ? "/scan" : "/choose-location";
  return path;
}

export function postAuthLanding(from: unknown, confirmed: boolean): string {
  return homeAfterSignIn(techTasksEnabled(), from, confirmed);
}
