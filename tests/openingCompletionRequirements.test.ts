import { describe, expect, it } from "vitest";
import { openingCompletionRequirements } from "../field-app/src/lib/openingCompletion";

describe("opening completion requirements", () => {
  it("lists every missing prerequisite for a single opening", () => {
    expect(openingCompletionRequirements({ opening_configuration: "single", door_leaves: [], hardware_components: [] }))
      .toEqual(["Save the frame", "Save the door leaf", "Add at least one hardware component"]);
  });

  it("requires both roles for a pair and reviewed hardware", () => {
    expect(openingCompletionRequirements({
      opening_configuration: "pair", frame: { id: "frame" },
      door_leaves: [{ leaf_role: "active" }], hardware_components: [{ review_state: "pending" }],
    })).toEqual(["Save both door leaves", "Review every hardware component"]);
  });

  it("allows completion only when all prerequisites are present", () => {
    expect(openingCompletionRequirements({
      opening_configuration: "single", frame: { id: "frame" },
      door_leaves: [{ leaf_role: "single" }], hardware_components: [{ review_state: "reviewed" }],
    })).toEqual([]);
  });
});
