import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../dashboard/src/lib/api";
import { STALE_IMPORT_MESSAGE, kindChangeWarning, scheduleChangeErrorMessage } from "../dashboard/src/lib/scheduleUi";

// M3B dashboard: type-change warning, archive controls, stale-draft notice.
describe("M3B schedule type correction UI", () => {
  it("warns only when the current file looks like the other type", () => {
    expect(kindChangeWarning("door", "Hardware.docx")).toMatch(/looks like a hardware schedule/);
    expect(kindChangeWarning("hardware", "Hardware.docx")).toBe(null);
    expect(kindChangeWarning("hardware", "Doors.xlsx")).toMatch(/looks like a door schedule/);
    expect(kindChangeWarning("door", "plan.pdf")).toBe(null);
    expect(kindChangeWarning("door", undefined)).toBe(null);
  });
  it("maps API errors to plain messages", () => {
    expect(scheduleChangeErrorMessage(new ApiError(409, "schedule_used_by_confirmed_import"))).toMatch(/confirmed import/);
    expect(scheduleChangeErrorMessage(new ApiError(403, "insufficient_role_for_action"))).toMatch(/role/);
    expect(scheduleChangeErrorMessage(new Error("x"))).toBe("The change failed. Nothing was changed.");
  });
  it("schedules page has Change type, Archive/Unarchive and Show archived; acknowledge sent only after a warning", () => {
    const src = readFileSync("dashboard/src/pages/FacilitySchedulesPage.tsx", "utf8");
    expect(src).toContain(">Change type</button>");
    expect(src).toContain('s.archived_at ? "Unarchive" : "Archive"');
    expect(src).toContain("Show archived");
    expect(src).toContain("...(warning ? { acknowledge_mismatch: true } : {})");
    expect(src).toContain("window.confirm(warning");
  });
  it("import review blocks confirm on a stale draft and offers to start again", () => {
    const src = readFileSync("dashboard/src/pages/ScheduleImportPage.tsx", "utf8");
    expect(src).toContain("disabled={plan.blocked || busy || !!data.import.stale}");
    expect(src).toContain('"import_stale_schedule_type_changed") return STALE_IMPORT_MESSAGE');
    expect(STALE_IMPORT_MESSAGE).toMatch(/Start the import again/);
  });
});