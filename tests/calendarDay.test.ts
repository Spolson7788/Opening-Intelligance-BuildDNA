import { expect, it } from "vitest";
import { formatStoredCalendarDay, localCalendarDay } from "../field-app/src/lib/calendarDay";

it("uses the Phoenix local day at 5:30pm when UTC is already the next day", () => {
  const instant = new Date("2026-11-10T00:30:00.000Z");
  expect(instant.toISOString().slice(0, 10)).toBe("2026-11-10");
  expect(localCalendarDay(instant, "America/Phoenix")).toBe("2026-11-09");
});

it("shows a stored calendar day without moving it", () => {
  expect(formatStoredCalendarDay("2026-11-09")).toBe(new Date("2026-11-09T00:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC" }));
  expect(formatStoredCalendarDay("2026-11-09T18:30:00.000Z")).toContain("2026");
});
