import { describe, expect, it } from "vitest";
import type { Opening, Property } from "../dashboard/src/lib/api";
import {
  conditionBand, countBands, countyBadge, formatUsd, groupByStateCounty, needsAttentionCount, summarizeCorrectiveWork,
} from "../dashboard/src/lib/portfolioOverview";

const property = (id: string, building: string, state: string, county: string): Property => ({
  id, name: id, city: null, state, state_code: state, state_name: state, county_name: county, county_fips: "00000",
  buildings: [{ id: building, name: building }],
});
const opening = (id: string, building: string, score: number | null, fire = false): Opening => ({
  id, opening_code: id, building_id: building, floor_label: null, location_description: null,
  opening_type: "door", fire_rated: fire, life_safety_critical: false, is_electrified: false,
  health_score: score, status: "active", opening_configuration: "single", completion_state: "complete",
});

describe("portfolio overview figures", () => {
  it("buckets real health scores and does not invent a service total", () => {
    expect(conditionBand(90)).toBe("healthy");
    expect(conditionBand(60)).toBe("monitor");
    expect(conditionBand(30)).toBe("serious");
    expect(conditionBand(10)).toBe("critical");
    expect(conditionBand(null)).toBe("unassessed");
    expect(countBands([90, 60, 30, 10, null])).toEqual({ healthy: 1, monitor: 1, serious: 1, critical: 1, unassessed: 1 });
    expect(needsAttentionCount([90, 40, null])).toBe(1);
  });

  it("groups properties by the state and county already on each facility", () => {
    const groups = groupByStateCounty(
      [property("p1", "b1", "Arizona", "Maricopa County"), property("p2", "b2", "Arizona", "Maricopa County")],
      [opening("o1", "b1", 92), opening("o2", "b2", 34)],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].state).toBe("Arizona");
    expect(groups[0].openingCount).toBe(2);
    expect(groups[0].counties[0]).toMatchObject({ county: "Maricopa County", propertyCount: 2, openingCount: 2 });
    expect(countyBadge(groups[0].counties[0].bands).label).toBe("1 serious");
  });

  it("sums the capital-forecast rollup instead of a placeholder dollar amount", () => {
    const summary = summarizeCorrectiveWork([{
      property_id: "p", property_name: "P", total_openings: 2,
      buckets: {
        urgent: { label: "Urgent", total: 1, by_type: {}, needing_estimate_by_type: { door: 2 }, known_cost_total: 1200 },
        near_term: { label: "Near", total: 0, by_type: {}, needing_estimate_by_type: {}, known_cost_total: 0 },
        healthy: { label: "Healthy", total: 1, by_type: {}, needing_estimate_by_type: {}, known_cost_total: 50.4 },
        unassessed: { label: "Unassessed", total: 0, by_type: {}, needing_estimate_by_type: {}, known_cost_total: 0 },
      },
    }]);
    expect(summary).toEqual({ knownCost: 1250.4, awaitingEstimate: 2 });
    expect(formatUsd(1250.4)).toBe("$1,250");
  });
});
