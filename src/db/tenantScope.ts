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
    WHERE pf.organization_id = $${paramIndex}
  `;
}

export function propertiesForOrgSubquery(paramIndex: number): string {
  return `
    SELECT p.id FROM properties p
    JOIN portfolios pf ON pf.id = p.portfolio_id
    WHERE pf.organization_id = $${paramIndex}
  `;
}

export function openingsForOrgSubquery(paramIndex: number): string {
  return `
    SELECT o.id FROM openings o
    JOIN buildings b ON b.id = o.building_id
    JOIN properties p ON p.id = b.property_id
    JOIN portfolios pf ON pf.id = p.portfolio_id
    WHERE pf.organization_id = $${paramIndex}
  `;
}
