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
