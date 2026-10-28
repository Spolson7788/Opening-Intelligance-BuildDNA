import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL, CATEGORY_ORDER, MATCH_LABEL, comparisonErrorMessage, fieldGroup, filterOpenings, floorsOf, type ComparisonOpening } from "../dashboard/src/lib/comparisonUi";
import { COMPARISON_CATEGORIES } from "../src/services/scheduleComparison";

const line = (category: any, entity = "opening", field: string | null = null) => ({ category, mark: "1", opening_id: "o", opening_code: "C", entity, field, schedule_value: null, field_value: null, note: null });
const o = (p: Partial<ComparisonOpening>): ComparisonOpening => ({ mark: "1", source_row: 2, opening_id: "o", opening_code: "C", floor_label: null, match: "mark", surveyed: true,
  surveyed_at: null, surveyed_by_role: null, status: "matched", set_key: null, lines: [], ...p });

describe("M4 comparison page helpers", () => {
  it("labels exactly the six engine categories, in order", () => {
    expect(CATEGORY_ORDER).toEqual([...COMPARISON_CATEGORIES]);
    expect(CATEGORY_LABEL.not_in_schedule).toBe("In field, not in schedule");
    expect(MATCH_LABEL("code")).toBe("matched by code"); expect(MATCH_LABEL(null)).toBe("");
  });
  it("groups fields for the field filter", () => {
    expect(fieldGroup(line("field_mismatch", "door_leaf", "single.width_in"))).toBe("size");
    expect(fieldGroup(line("field_mismatch", "opening", "fire_rated"))).toBe("fire");
    expect(fieldGroup(line("field_mismatch", "frame", "material"))).toBe("material");
    expect(fieldGroup(line("hardware_difference", "hardware", "S1#1 hinge"))).toBe("hardware");
  });
  it("filters by category, surveyed, field, mark, floor and only mismatches", () => {
    const list = [
      o({ mark: "101", floor_label: "L1", status: "differences", lines: [line("field_mismatch", "door_leaf", "single.height_in"), line("hardware_difference", "hardware", "x")] }),
      o({ mark: "103", surveyed: false, status: "not_surveyed", lines: [line("scheduled_not_surveyed")] }),
      o({ mark: null, opening_code: "FIELD-9", floor_label: "L2", match: null, status: "not_in_schedule", lines: [line("not_in_schedule")] }),
    ];
    expect(filterOpenings(list, {}).length).toBe(3);
    expect(filterOpenings(list, { category: "scheduled_not_surveyed" }).map((x) => x.mark)).toEqual(["103"]);
    expect(filterOpenings(list, { surveyed: "no" }).map((x) => x.mark)).toEqual(["103"]);
    expect(filterOpenings(list, { field: "size" })[0].lines.length).toBe(1);
    expect(filterOpenings(list, { onlyDifferences: true }).map((x) => x.mark)).toEqual(["101"]);
    expect(filterOpenings(list, { search: "field" }).map((x) => x.opening_code)).toEqual(["FIELD-9"]);
    expect(filterOpenings(list, { floor: "L1" }).map((x) => x.mark)).toEqual(["101"]);
    expect(floorsOf(list)).toEqual(["L1", "L2"]);
  });
  it("explains errors in plain words", () => {
    expect(comparisonErrorMessage("import_not_confirmed")).toMatch(/confirmed imports/);
    expect(comparisonErrorMessage("comparisons_unavailable")).toMatch(/not available/);
  });
  it("page has run, snapshot list, filters and CSV from the snapshot; import page links to it", () => {
    const src = readFileSync("dashboard/src/pages/ScheduleComparisonPage.tsx", "utf8");
    for (const s of ["Run comparison", "Saved snapshots", "Export CSV", "downloadComparisonCsv(snap.id)", "Only mismatches"]) expect(src).toContain(s);
    expect(readFileSync("dashboard/src/pages/ScheduleImportPage.tsx", "utf8")).toContain("Compare with field");
    expect(readFileSync("dashboard/src/App.tsx", "utf8")).toContain('/schedule-imports/:id/comparison/:snapshotId');
  });
});