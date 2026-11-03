import { pool } from "./pool";

// Openings a user may see or work. Customer organizations are unchanged.
// Provider technicians are limited to facilities inside their state/county
// area (their own area if one is set, otherwise their branch's area) that
// are assigned to their company.
export function openingsVisibleToUserSubquery(paramIndex: number): string {
  return `SELECT o.id FROM openings o WHERE oi_private.can_work_opening($${paramIndex}::uuid, o.id)`;
}

export async function userCanWorkOpening(userId: string, openingId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT oi_private.can_work_opening($1::uuid, $2::uuid) AS allowed`,
    [userId, openingId]
  );
  return result.rows[0]?.allowed === true;
}

export async function userCanReadProperty(userId: string, propertyId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT oi_private.can_read_property($1::uuid, $2::uuid) AS allowed`,
    [userId, propertyId]
  );
  return result.rows[0]?.allowed === true;
}
