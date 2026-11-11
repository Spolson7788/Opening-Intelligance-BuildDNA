/** Same-origin return from Field sign-in back to the facility dashboard home. */
export const FACILITY_DASHBOARD_HOME = "/facility-dashboard/";
export const FACILITY_DASHBOARD_SIGN_IN = "/field/login?next=" + encodeURIComponent(FACILITY_DASHBOARD_HOME);

const ALLOWED = new Set(["/facility-dashboard", "/facility-dashboard/", "/facility-dashboard/index.html"]);

export function facilityDashboardReturn(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("://")) return null;
  return ALLOWED.has(value) ? FACILITY_DASHBOARD_HOME : null;
}

/** The Field menu item is only for a verified staff session that already has office access to the selected company. */
export function showFacilityDashboardShortcut(input: { mfaVerified: boolean; staff: boolean; allowed: boolean; role: string }): boolean {
  if (input.role === "technician" || input.role === "inspector" || input.role === "viewer") return false;
  return input.mfaVerified === true && input.staff === true && input.allowed === true;
}

export function tokenHasVerifiedStaffSession(token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.mfaVerified === true && payload.mfaPending !== true;
  } catch {
    return false;
  }
}
