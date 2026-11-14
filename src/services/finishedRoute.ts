export type FinishedVisit = {
  property_id: string;
  visit_id: string;
  finished_at: string;
  doors_done: number;
};

export type FinishedRouteStop = {
  position: number;
  status: string;
  property_id: string;
  property_name: string;
  address: string;
};

export type FinishedSite = {
  property_id: string;
  property_name: string;
  address: string;
  doors_done: number;
  finished_at: string;
  visit_id: string;
};

/** Sites on yesterday's route that this tech finished, in the manager's stop order. */
export function finishedSitesInRouteOrder(stops: FinishedRouteStop[], visits: FinishedVisit[]): FinishedSite[] {
  const byProperty = new Map(visits.map((visit) => [visit.property_id, visit]));
  const seen = new Set<string>();
  const sites: FinishedSite[] = [];
  const ordered = [...stops].filter((stop) => stop.status === "approved").sort((a, b) => a.position - b.position || a.property_id.localeCompare(b.property_id));
  for (const stop of ordered) {
    if (!stop.property_id || seen.has(stop.property_id)) continue;
    const visit = byProperty.get(stop.property_id);
    if (!visit?.visit_id || !visit.finished_at) continue;
    seen.add(stop.property_id);
    sites.push({
      property_id: stop.property_id,
      property_name: stop.property_name,
      address: stop.address,
      doors_done: visit.doors_done,
      finished_at: visit.finished_at,
      visit_id: visit.visit_id,
    });
  }
  return sites;
}
