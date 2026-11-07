import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { userCanReadProperty } from "../db/areaAccess";

export const facilitiesRouter = Router();
facilitiesRouter.use(requireAuth);
facilitiesRouter.use(enforceRolePermissions);
facilitiesRouter.use(auditLog);

// Facilities the caller is allowed to see. Provider technicians only get
// facilities inside their assigned state/county area. Results are ordered
// so a client can group them by state, then county, without a second query.
facilitiesRouter.get("/", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.address_line1, p.city, p.state, p.postal_code, p.property_type,
              p.state_code, p.county_fips, s.name AS state_name, c.name AS county_name,
              (SELECT count(*)::int FROM openings o
               JOIN buildings b ON b.id = o.building_id
               WHERE b.property_id = p.id) AS opening_count
       FROM properties p
       LEFT JOIN us_states s ON s.code = p.state_code
       LEFT JOIN us_counties c ON c.fips = p.county_fips
       WHERE oi_private.can_read_property($1::uuid, p.id)
       ORDER BY s.name NULLS LAST, c.name NULLS LAST, p.name`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

facilitiesRouter.get("/:propertyId/openings", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { propertyId } = req.params;
  try {
    if (!(await userCanReadProperty(userId, propertyId))) {
      return res.status(404).json({ error: "not_found" });
    }
    const result = await pool.query(
      `SELECT o.id, o.opening_code, o.opening_type, o.floor_label, o.location_description, o.health_score, o.status
       FROM openings o
       JOIN buildings b ON b.id = o.building_id
       WHERE b.property_id = $1
       ORDER BY o.opening_code`,
      [propertyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
