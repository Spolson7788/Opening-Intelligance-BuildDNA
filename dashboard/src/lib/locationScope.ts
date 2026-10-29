// M3: parent-company combined dashboard. Pure helpers (unit-tested) for the location filter,
// the Location column, grouping, roll-ups and write gating. No I/O here.
import type { LocationsResponse, LocationCompany, LocationFacility, CompanyChoice } from "./api";

export type LocationFilter =
  | { kind: "company" }                 // the active company only (default; no tree read)
  | { kind: "all" }                     // every location in the visible tree
  | { kind: "branch"; orgId: string }   // one company in the tree and everything under it
  | { kind: "facility"; propertyId: string }; // a single location

export const DEFAULT_FILTER: LocationFilter = { kind: "company" };
export const needsTree = (f: LocationFilter) => f.kind !== "company";

export function parseFilter(raw: string | null | undefined): LocationFilter {
  try {
    const f = JSON.parse(raw ?? "");
    if (f?.kind === "all" || f?.kind === "company") return { kind: f.kind };
    if (f?.kind === "branch" && typeof f.orgId === "string") return { kind: "branch", orgId: f.orgId };
    if (f?.kind === "facility" && typeof f.propertyId === "string") return { kind: "facility", propertyId: f.propertyId };
  } catch { /* fall through */ }
  return DEFAULT_FILTER;
}

/** The company switcher only appears for people with more than one company. */
export function uniqueCompanies(list: CompanyChoice[]): CompanyChoice[] {
  const seen = new Map<string, CompanyChoice>();
  for (const c of list) if (!seen.has(c.organization_id) || c.is_home) seen.set(c.organization_id, c);
  return [...seen.values()];
}
export const showCompanySwitcher = (list: CompanyChoice[]) => uniqueCompanies(list).length > 1;

export interface LocationRow { property_id?: string | null; building_id?: string | null; property_name?: string | null; organization_id?: string | null }

export class LocationIndex {
  readonly companies = new Map<string, LocationCompany>();
  readonly facilities = new Map<string, LocationFacility>();
  readonly byBuilding = new Map<string, LocationFacility>();
  readonly byName = new Map<string, LocationFacility>();
  readonly data: LocationsResponse | null;
  constructor(data: LocationsResponse | null) {
    this.data = data;
    for (const c of data?.companies ?? []) this.companies.set(c.id, c);
    for (const f of data?.facilities ?? []) {
      this.facilities.set(f.id, f);
      for (const b of f.building_ids ?? []) this.byBuilding.set(b, f);
      if (!this.byName.has(f.name)) this.byName.set(f.name, f);
    }
  }
  get active() { return this.data?.active_organization_id ?? null; }
  /** True when the caller can see more than one company (parent admins / managers). */
  get tree() { return !!this.data?.tree; }
  get canExportTree() { return !!this.data?.can_export_tree; }

  facilityOf(row: LocationRow): LocationFacility | null {
    return (row.property_id && this.facilities.get(row.property_id))
      || (row.building_id && this.byBuilding.get(row.building_id))
      || (row.property_name && this.byName.get(row.property_name)) || null;
  }
  companyOf(row: LocationRow): LocationCompany | null {
    const f = this.facilityOf(row);
    const id = f?.organization_id ?? row.organization_id ?? null;
    return id ? this.companies.get(id) ?? null : null;
  }
  /** "Company / Facility" for every row; facility only when the owner is outside the caller's tree (provider view). */
  label(row: LocationRow): string {
    const f = this.facilityOf(row), c = this.companyOf(row);
    if (f && c) return `${c.name} / ${f.name}`;
    return f?.name ?? c?.name ?? row.property_name ?? "—";
  }
  /** Company ids of orgId and every descendant in the visible tree. */
  subtree(orgId: string): Set<string> {
    const out = new Set([orgId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of this.companies.values()) if (c.parent_organization_id && out.has(c.parent_organization_id) && !out.has(c.id)) { out.add(c.id); grew = true; }
    }
    return out;
  }
  inFilter(row: LocationRow, f: LocationFilter): boolean {
    if (f.kind === "all") return true;
    if (f.kind === "company") { const c = this.companyOf(row); return !c || c.id === this.active; }
    if (f.kind === "facility") return this.facilityOf(row)?.id === f.propertyId;
    const c = this.companyOf(row);
    return !!c && this.subtree(f.orgId).has(c.id);
  }
  /**
   * Writes always go to the ONE active company. A row in another company is read-only here
   * (an admin can switch into it to edit); a parent manager is view-only in child locations
   * even after switching (access tree_view), so write actions are hidden for them.
   */
  writeState(row: LocationRow): "write" | "switch_to_edit" | "view_only" {
    const c = this.companyOf(row);
    if (!c || c.id === this.active) return c?.access === "tree_view" ? "view_only" : "write";
    return c.access === "tree_view" ? "view_only" : "switch_to_edit";
  }
  /** Companies a create action may target: only ones where the caller is not view-only. */
  createTargets(): LocationCompany[] {
    return [...this.companies.values()].filter(c => c.access !== "tree_view" && c.role !== "viewer");
  }
}

export function groupByLocation<T extends LocationRow>(rows: T[], idx: LocationIndex): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = idx.label(r); m.set(k, [...(m.get(k) ?? []), r]); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export interface LocationTotals { facility_id: string | null; label: string; openings: number; assessed: number; avg_health: number | null; urgent: number; near_term: number }
/** Rolled-up totals and health per location (urgent < 50, near term < 75, like the forecast buckets). */
export function rollupByLocation(rows: (LocationRow & { health_score?: number | null })[], idx: LocationIndex): { total: LocationTotals; locations: LocationTotals[] } {
  const make = (label: string, id: string | null): LocationTotals => ({ facility_id: id, label, openings: 0, assessed: 0, avg_health: null, urgent: 0, near_term: 0 });
  const by = new Map<string, LocationTotals & { sum: number }>();
  const total = { ...make("All locations", null), sum: 0 };
  for (const r of rows) {
    const f = idx.facilityOf(r), key = f?.id ?? idx.label(r);
    const t = by.get(key) ?? { ...make(idx.label(r), f?.id ?? null), sum: 0 };
    for (const x of [t, total]) {
      x.openings++;
      if (typeof r.health_score === "number") { x.assessed++; x.sum += r.health_score; if (r.health_score < 50) x.urgent++; else if (r.health_score < 75) x.near_term++; }
    }
    by.set(key, t);
  }
  const fin = ({ sum, ...x }: LocationTotals & { sum: number }): LocationTotals => ({ ...x, avg_health: x.assessed ? Math.round(sum / x.assessed) : null });
  return { total: fin(total), locations: [...by.values()].map(fin).sort((a, b) => a.label.localeCompare(b.label)) };
}
