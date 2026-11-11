// The facility dashboard is the customer office view of one customer's own facilities.
// A customer administrator or facilities manager of the active company may open it.
// Verified Opening Intelligence staff may open it only for a company they already
// belong to in one of those office roles (organization_memberships, checked by
// requireAuth through user_authorized_orgs). Staff status does not open every
// facility, and a technician, inspector, or viewer membership does not qualify.
const OFFICE_ROLES = new Set(["admin", "facilities_manager"]);

export function customerMayOpenFacilityDashboard(orgType: unknown, role: unknown): boolean {
  return orgType === "customer" && OFFICE_ROLES.has(String(role));
}

export function mayOpenFacilityDashboard(input: {
  orgType: unknown;
  role: unknown;
  staff?: boolean;
  mfaVerified?: boolean;
}): boolean {
  const office = customerMayOpenFacilityDashboard(input.orgType, input.role);
  if (input.staff !== true) return office;
  return office && input.mfaVerified === true;
}
