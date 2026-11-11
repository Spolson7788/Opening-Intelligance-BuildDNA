import { expect, it } from "vitest";
import { facilityDashboardReturn, showFacilityDashboardShortcut, tokenHasVerifiedStaffSession, FACILITY_DASHBOARD_HOME, FACILITY_DASHBOARD_SIGN_IN } from "../field-app/src/lib/facilityDashboardReturn";

it("returns only the facility dashboard home", () => {
  expect(facilityDashboardReturn("/facility-dashboard/")).toBe(FACILITY_DASHBOARD_HOME);
  expect(facilityDashboardReturn("/facility-dashboard")).toBe(FACILITY_DASHBOARD_HOME);
  expect(facilityDashboardReturn("/facility-dashboard/index.html")).toBe(FACILITY_DASHBOARD_HOME);
  for (const blocked of ["https://evil.example/facility-dashboard/", "//evil.example", "/field/scan", "/facility-dashboard/../field/scan", "/facility-dashboard/?opening=1", "/dashboard/", "facility-dashboard/", ""]) {
    expect(facilityDashboardReturn(blocked)).toBeNull();
  }
  expect(FACILITY_DASHBOARD_SIGN_IN).toBe("/field/login?next=%2Ffacility-dashboard%2F");
});

it("shows the field shortcut only for verified staff who already have office access", () => {
  expect(showFacilityDashboardShortcut({ mfaVerified: true, staff: true, allowed: true, role: "admin" })).toBe(true);
  expect(showFacilityDashboardShortcut({ mfaVerified: true, staff: true, allowed: true, role: "facilities_manager" })).toBe(true);
  expect(showFacilityDashboardShortcut({ mfaVerified: true, staff: true, allowed: false, role: "admin" })).toBe(false);
  expect(showFacilityDashboardShortcut({ mfaVerified: true, staff: false, allowed: true, role: "admin" })).toBe(false);
  expect(showFacilityDashboardShortcut({ mfaVerified: false, staff: true, allowed: true, role: "admin" })).toBe(false);
  expect(showFacilityDashboardShortcut({ mfaVerified: true, staff: true, allowed: true, role: "technician" })).toBe(false);
  expect(showFacilityDashboardShortcut({ mfaVerified: true, staff: true, allowed: true, role: "inspector" })).toBe(false);
  const header = Buffer.from(JSON.stringify({ mfaVerified: true })).toString("base64");
  expect(tokenHasVerifiedStaffSession(`x.${header}.y`)).toBe(true);
  const customer = Buffer.from(JSON.stringify({ role: "admin" })).toString("base64");
  expect(tokenHasVerifiedStaffSession(`x.${customer}.y`)).toBe(false);
});
