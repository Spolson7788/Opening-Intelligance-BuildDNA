import { expect, it } from "vitest";
import { scheduledLeafWidths } from "../src/services/scheduleImport";

it("uses two schedule widths for an uneven pair and estimates an even split otherwise", () => {
  expect(scheduledLeafWidths({ width_in: 66, raw: { Width: "36 / 30" }, configuration: "Pair" }, true)).toEqual({ active: 36, inactive: 30, estimated: false });
  expect(scheduledLeafWidths({ width_in: 72, description: "pair of doors", configuration: "PR" }, true)).toEqual({ active: 36, inactive: 36, estimated: true });
  expect(scheduledLeafWidths({ width_in: 36, configuration: "Single" }, false).active).toBe(36);
});
