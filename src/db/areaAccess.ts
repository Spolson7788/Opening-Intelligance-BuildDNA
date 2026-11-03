import { pool } from "./pool";
import { isMissingSchema } from "../middleware/auth";

// Technician area if one is set, otherwise the branch area. Non-technicians,
// and technicians whose company has not declared any areas, are allowed.
// A database that has not applied the coverage migration is treated as allowed
// so older test databases keep their current behavior.
export async function areaAllowsProperty(userId: string, propertyId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT oi_private.caller_area_allows($1::uuid, $2::uuid) AS allowed`,
      [userId, propertyId]
    );
    return result.rows[0]?.allowed === true;
  } catch (error) {
    if (isMissingSchema(error)) return true;
    throw error;
  }
}

export async function areaAllowsOpening(userId: string, openingId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT oi_private.caller_area_allows($1::uuid, b.property_id) AS allowed
       FROM openings o JOIN buildings b ON b.id = o.building_id
       WHERE o.id = $2`,
      [userId, openingId]
    );
    if (result.rows.length === 0) return true;
    return result.rows[0].allowed === true;
  } catch (error) {
    if (isMissingSchema(error)) return true;
    throw error;
  }
}
