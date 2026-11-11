import { expect, it } from "vitest";
import { draftsFromSuggestions, parseEditedInches, planMeasurementSave, validateMeasurementDrafts } from "../field-app/src/lib/measurementSuggestions";
import type { MeasurementDraft } from "../field-app/src/lib/measurementSuggestions";

function draft(patch: Partial<MeasurementDraft> & Pick<MeasurementDraft, "field" | "text">): MeasurementDraft {
  return { id: patch.field, included: true, readInches: null, confidence: null, bounds: "", ...patch };
}

it("reads edited sizes as inches", () => {
  expect(parseEditedInches("3' 11\"")).toBe(47);
  expect(parseEditedInches("47")).toBe(47);
  expect(parseEditedInches("47in")).toBe(47);
  expect(parseEditedInches("47 in")).toBe(47);
  expect(parseEditedInches("8'")).toBe(96);
  expect(parseEditedInches("96")).toBe(96);
  expect(parseEditedInches("7' 9\"")).toBe(93);
  expect(parseEditedInches("nope")).toBeNull();
});

it("keeps a photo value, marks an edit, and plans one frame save", () => {
  const drafts = draftsFromSuggestions([
    { field: "frame_width", inches: 47, confidence: 0.95, bounds: "frame width: 3' 11\"" },
    { field: "frame_height", inches: 93, confidence: 0.95, bounds: "frame height: 7' 9\"" },
  ], "pair", () => "id");
  drafts[1].text = "8'";
  const checked = validateMeasurementDrafts(drafts, "pair");
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.accepted).toEqual([
    { field: "frame_width", inches: 47, source: "photo" },
    { field: "frame_height", inches: 96, source: "edited" },
  ]);
  expect(planMeasurementSave(checked.accepted, "pair")).toEqual([{
    kind: "opening_frame",
    role: null,
    width_in: 47,
    height_in: 96,
    lines: ["Frame width 3' 11\" from the measurement photo.", "Frame height 8' 0\" edited."],
  }]);
});

it("sends an uneven pair to the active and inactive leaves", () => {
  const checked = validateMeasurementDrafts([
    draft({ field: "active_width", text: "36", readInches: 36 }),
    draft({ field: "inactive_width", text: "30", readInches: 30 }),
  ], "pair");
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(planMeasurementSave(checked.accepted, "pair").map((group) => ({ role: group.role, width_in: group.width_in }))).toEqual([
    { role: "active", width_in: 36 },
    { role: "inactive", width_in: 30 },
  ]);
});

it("puts a single-door leaf on the single leaf and refuses a duplicate or an out-of-range size", () => {
  const single = validateMeasurementDrafts([draft({ field: "active_width", text: "36", readInches: 36 })], "single");
  expect(single.ok).toBe(true);
  if (single.ok) expect(planMeasurementSave(single.accepted, "single")[0].role).toBe("single");
  const duplicate = validateMeasurementDrafts([
    draft({ id: "a", field: "frame_width", text: "47" }),
    draft({ id: "b", field: "frame_width", text: "48" }),
  ], "pair");
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.problems.join(" ")).toContain("more than once");
  for (const text of ["11", "241", "0", ""]) {
    const range = validateMeasurementDrafts([draft({ field: "frame_height", text })], "pair");
    expect(range.ok).toBe(false);
  }
  expect(validateMeasurementDrafts([draft({ field: "frame_height", text: "12" })], "pair").ok).toBe(true);
  expect(validateMeasurementDrafts([draft({ field: "frame_height", text: "240" })], "pair").ok).toBe(true);
  const excluded = validateMeasurementDrafts([draft({ field: "frame_width", text: "47", included: false })], "pair");
  expect(excluded.ok).toBe(false);
});
