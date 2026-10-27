// Shared facility access: canonical owner or explicit current provider assignment.
// Membership comes from requireAuth's fresh database lookup, never email suffix.
export function facilityAccessPredicate(orgParameter: number): string {
 return `(pf.organization_id=$${orgParameter} OR EXISTS (
 SELECT 1 FROM facility_provider_assignments fpa
 WHERE fpa.property_id=p.id AND fpa.provider_organization_id=$${orgParameter}
 AND fpa.revoked_at IS NULL))`;
}

// Reusable subquery fragment: given a placeholder index for organization_id,
// returns a SQL snippet that restricts `building_id` (or `opening_id` via join)
// to buildings owned, through the property/portfolio chain, by that organization.
//
// Usage: `... WHERE building_id IN (${buildingsForOrg(1)}) AND $2 = ...`

export function buildingsForOrgSubquery(paramIndex: number): string {
  return `
    SELECT b.id FROM buildings b
    JOIN properties p ON p.id = b.property_id
    JOIN portfolios pf ON pf.id = p.portfolio_id
    WHERE ${facilityAccessPredicate(paramIndex)}
  `;
}

export function propertiesForOrgSubquery(paramIndex: number): string {
  return `
    SELECT p.id FROM properties p
    JOIN portfolios pf ON pf.id = p.portfolio_id
    WHERE ${facilityAccessPredicate(paramIndex)}
  `;
}

export function openingsForOrgSubquery(paramIndex: number): string {
  return `
    SELECT o.id FROM openings o
    JOIN buildings b ON b.id = o.building_id
    JOIN properties p ON p.id = b.property_id
    JOIN portfolios pf ON pf.id = p.portfolio_id
    WHERE ${facilityAccessPredicate(paramIndex)}
  `;
}

// Facility schedules (M1). A "service provider" is an organization holding an
// active facility_provider_assignments row for the property; access starts on
// assignment and ends on revocation. Owner and provider org members with these
// roles may upload and list; all other roles are denied.
export const SCHEDULE_WRITE_ROLES = ["admin", "facilities_manager"];

export async function facilityScheduleAccess(
  db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> },
  propertyId: string,
  orgId: string,
): Promise<"owner" | "provider" | null> {
  const r = await db.query(
    `SELECT CASE WHEN pf.organization_id=$2 THEN 'owner' ELSE 'provider' END AS access
     FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id
     WHERE p.id=$1 AND ${facilityAccessPredicate(2)}`,
    [propertyId, orgId],
  );
  return r.rows[0]?.access ?? null;
}
