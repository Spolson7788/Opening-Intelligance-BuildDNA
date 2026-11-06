import type { CapitalForecastRollupProperty, Opening, Property } from "./api";

export type ConditionBand = "healthy" | "monitor" | "serious" | "critical" | "unassessed";

export interface BandCounts {
  healthy: number;
  monitor: number;
  serious: number;
  critical: number;
  unassessed: number;
}

/** Health bands from the score already stored on each opening. Null means not assessed. */
export function conditionBand(score: number | null | undefined): ConditionBand {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return "unassessed";
  if (score >= 75) return "healthy";
  if (score >= 50) return "monitor";
  if (score >= 25) return "serious";
  return "critical";
}

export function countBands(scores: Array<number | null | undefined>): BandCounts {
  const counts: BandCounts = { healthy: 0, monitor: 0, serious: 0, critical: 0, unassessed: 0 };
  for (const score of scores) counts[conditionBand(score)] += 1;
  return counts;
}

export function needsAttentionCount(scores: Array<number | null | undefined>): number {
  return scores.filter((score) => score !== null && score !== undefined && !Number.isNaN(Number(score)) && score < 50).length;
}

export interface CountySummary {
  county: string;
  propertyCount: number;
  openingCount: number;
  bands: BandCounts;
}

export interface StateSummary {
  state: string;
  openingCount: number;
  counties: CountySummary[];
}

function areaNames(property: Property | undefined): { state: string; county: string } {
  return {
    state: property?.state_name || property?.state_code || "State not set",
    county: property?.county_name || property?.county_fips || "County not set",
  };
}

/** Openings and properties the dashboard already loaded, grouped for the state/county card. */
export function groupByStateCounty(properties: Property[], openings: Opening[]): StateSummary[] {
  const byBuilding = new Map<string, Property>();
  for (const property of properties) for (const building of property.buildings ?? []) byBuilding.set(building.id, property);

  const states = new Map<string, Map<string, { properties: Set<string>; scores: Array<number | null> }>>();
  const bucket = (state: string, county: string) => {
    let counties = states.get(state);
    if (!counties) { counties = new Map(); states.set(state, counties); }
    let row = counties.get(county);
    if (!row) { row = { properties: new Set(), scores: [] }; counties.set(county, row); }
    return row;
  };

  for (const property of properties) {
    const area = areaNames(property);
    bucket(area.state, area.county).properties.add(property.id);
  }
  for (const opening of openings) {
    const property = byBuilding.get(opening.building_id);
    const area = areaNames(property);
    const row = bucket(area.state, area.county);
    if (property) row.properties.add(property.id);
    row.scores.push(opening.health_score);
  }

  return [...states.entries()]
    .map(([state, counties]) => {
      const countyRows = [...counties.entries()]
        .map(([county, row]) => ({
          county,
          propertyCount: row.properties.size,
          openingCount: row.scores.length,
          bands: countBands(row.scores),
        }))
        .sort((a, b) => a.county.localeCompare(b.county));
      return {
        state,
        openingCount: countyRows.reduce((sum, row) => sum + row.openingCount, 0),
        counties: countyRows,
      };
    })
    .sort((a, b) => a.state.localeCompare(b.state));
}

/** The existing capital-forecast rollup: known hardware cost and openings with no unit cost. */
export function summarizeCorrectiveWork(properties: CapitalForecastRollupProperty[]): { knownCost: number; awaitingEstimate: number } {
  let knownCost = 0;
  let awaitingEstimate = 0;
  for (const property of properties) {
    for (const bucket of Object.values(property.buckets ?? {})) {
      knownCost += Number(bucket.known_cost_total) || 0;
      awaitingEstimate += Object.values(bucket.needing_estimate_by_type ?? {}).reduce((sum, count) => sum + Number(count || 0), 0);
    }
  }
  return { knownCost, awaitingEstimate };
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

/** One badge per county, from the counts above. Critical outranks the milder bands. */
export function countyBadge(bands: BandCounts): { label: string; tone: ConditionBand } {
  if (bands.critical > 0) return { label: `${bands.critical} critical`, tone: "critical" };
  if (bands.serious > 0) return { label: `${bands.serious} serious`, tone: "serious" };
  if (bands.monitor > 0) return { label: `${bands.monitor} monitor`, tone: "monitor" };
  if (bands.healthy > 0) return { label: `${bands.healthy} healthy`, tone: "healthy" };
  return { label: `${bands.unassessed} not assessed`, tone: "unassessed" };
}
