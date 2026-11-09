// The facility dashboard is the customer office view of one customer's own facilities.
// Provider company admin, field technician, inspector, viewer, internal staff, and an
// unknown organization type do not qualify. Platform staff status is not consulted:
// it does not grant this dashboard. The active company and role come from requireAuth's
// database lookup, not from the browser.
export function customerMayOpenFacilityDashboard(orgType: unknown, role: unknown): boolean {
  return orgType === "customer" && (role === "admin" || role === "facilities_manager");
}
