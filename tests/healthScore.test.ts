import { describe, it, expect } from "vitest";
import { computeHealthScore } from "../src/services/healthScore";

describe("computeHealthScore", () => {
  it("gives a near-perfect score to a new, well-maintained, fire-rated opening", () => {
    const { score } = computeHealthScore({
      installDate: new Date(),
      lastServiceDate: new Date(),
      serviceEventsLast12Months: 1,
      failedInspectionsLast24Months: 0,
      openComplianceIssues: 0,
      fireRated: true,
    });
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it("penalizes an opening with no known install date", () => {
    const withDate = computeHealthScore({
      installDate: new Date(),
      lastServiceDate: new Date(),
      serviceEventsLast12Months: 0,
      failedInspectionsLast24Months: 0,
      openComplianceIssues: 0,
      fireRated: false,
    });
    const withoutDate = computeHealthScore({
      installDate: null,
      lastServiceDate: new Date(),
      serviceEventsLast12Months: 0,
      failedInspectionsLast24Months: 0,
      openComplianceIssues: 0,
      fireRated: false,
    });
    expect(withoutDate.score).toBeLessThan(withDate.score);
  });

  it("penalizes an opening that's never been serviced more than one that has", () => {
    const serviced = computeHealthScore({
      installDate: new Date(),
      lastServiceDate: new Date(),
      serviceEventsLast12Months: 1,
      failedInspectionsLast24Months: 0,
      openComplianceIssues: 0,
      fireRated: false,
    });
    const neverServiced = computeHealthScore({
      installDate: new Date(),
      lastServiceDate: null,
      serviceEventsLast12Months: 0,
      failedInspectionsLast24Months: 0,
      openComplianceIssues: 0,
      fireRated: false,
    });
    expect(neverServiced.score).toBeLessThan(serviced.score);
  });

  it("weighs open compliance issues more heavily on fire-rated openings than non-fire-rated", () => {
    const fireRated = computeHealthScore({
      installDate: new Date(),
      lastServiceDate: new Date(),
      serviceEventsLast12Months: 0,
      failedInspectionsLast24Months: 0,
      openComplianceIssues: 1,
      fireRated: true,
    });
    const nonFireRated = computeHealthScore({
      installDate: new Date(),
      lastServiceDate: new Date(),
      serviceEventsLast12Months: 0,
      failedInspectionsLast24Months: 0,
      openComplianceIssues: 1,
      fireRated: false,
    });
    expect(fireRated.score).toBeLessThan(nonFireRated.score);
  });

  it("never returns a score outside 0-100", () => {
    const worstCase = computeHealthScore({
      installDate: new Date("1990-01-01"),
      lastServiceDate: new Date("2000-01-01"),
      serviceEventsLast12Months: 20,
      failedInspectionsLast24Months: 10,
      openComplianceIssues: 10,
      fireRated: true,
    });
    expect(worstCase.score).toBeGreaterThanOrEqual(0);
    expect(worstCase.score).toBeLessThanOrEqual(100);
  });

  it("always returns a factors breakdown explaining the score", () => {
    const { factors } = computeHealthScore({
      installDate: new Date(),
      lastServiceDate: new Date(),
      serviceEventsLast12Months: 0,
      failedInspectionsLast24Months: 1,
      openComplianceIssues: 0,
      fireRated: false,
    });
    expect(factors).toBeTruthy();
    expect(factors.failed_inspection_penalty).toBeLessThan(0);
  });
});
