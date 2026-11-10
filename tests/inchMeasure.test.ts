import { expect, it } from "vitest";
import { formatInches, pairLeafWidths, parseInches, unevenPair } from "../src/lib/inchMeasure";
import { dimensionPayload, parseInches as fieldParse, formatInches as fieldFormat } from "../field-app/src/lib/inchMeasure";

it("reads feet, inches, fractions, and decimals as inches", () => {
  expect(parseInches("3' 11 1/2\"")).toBe(47.5);
  expect(parseInches("47.5")).toBe(47.5);
  expect(parseInches("47 1/2")).toBe(47.5);
  expect(parseInches("3' - 0\"")).toBe(36);
  expect(parseInches("1 3/4")).toBe(1.75);
  expect(parseInches("")).toBeNull();
  expect(fieldParse("3' 11 1/2\"")).toBe(47.5);
});

it("formats inches back to feet and a fraction", () => {
  expect(formatInches(47.5)).toBe("3' 11 1/2\"");
  expect(formatInches(36)).toBe("3' 0\"");
  expect(formatInches(1.75)).toBe("1 3/4\"");
  expect(fieldFormat(84)).toBe("7' 0\"");
});

it("leaves a blank dimension unchanged and clears only on request", () => {
  expect(dimensionPayload({ text: "", clear: false })).toEqual({ set: false, value: null });
  expect(dimensionPayload({ text: "3' 0\"", clear: false })).toEqual({ set: true, value: 36 });
  expect(dimensionPayload({ text: "", clear: true })).toEqual({ set: true, value: null });
});

it("marks a pair uneven only when the leaf widths differ", () => {
  expect(unevenPair(36, 30)).toBe(true);
  expect(unevenPair(36, 36)).toBe(false);
  expect(pairLeafWidths({ pair: true, widthIn: 72, texts: ["36 / 30"] })).toEqual({ active: 36, inactive: 30, estimated: false });
  expect(pairLeafWidths({ pair: true, widthIn: 72, texts: [] })).toEqual({ active: 36, inactive: 36, estimated: true });
});
