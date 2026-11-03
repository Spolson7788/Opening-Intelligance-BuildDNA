import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest, isMissingSchema } from "../middleware/auth";
import { allowedOrgIds, facilityAccessPredicateAny } from "../db/tenantScope";

// Multi-company milestone 3: the dashboard's location picker. Lists the companies in the caller's
// visible tree (from user_authorized_orgs via the active company) and every facility they may read,
// each tagged with its owning company, so every list can show and filter by Location.
// Providers only ever get facilities with an active assignment (facilityAccessPredicateAny).
export const locationsRouter = Router();
locationsRouter.use(requireAuth);

export async function canExportTree(userId: string, activeOrgId: string): Promise<boolean> {
  // DB check: an admin of the active company (member or tree_admin) or active OI staff.
  try {
    const r = await pool.query(
      `SELECT is_platform_staff($1) OR EXISTS (SELECT 1 FROM user_authorized_orgs($1) t
         WHERE t.organization_id = $2 AND t.via_organization_id = $2 AND t.role = 'admin' AND t.access IN ('member','tree_admin')) AS ok`,
      [userId, activeOrgId]);
    return r.rows[0]?.ok === true;
  } catch (error) {
    if (isMissingSchema(error)) return false;
    throw error;
  }
}

locationsRouter.get("/", async (req: AuthedRequest, res) => {
  const a = req.auth!;
  const orgs = allowedOrgIds(a);
  try {
    const companies = (await pool.query(
      `SELECT o.id, o.name, o.parent_organization_id, t.access, t.role
       FROM user_authorized_orgs($1) t JOIN organizations o ON o.id = t.organization_id
       WHERE t.via_organization_id = $2 ORDER BY (o.id = $2) DESC, o.name`, [a.userId, a.organizationId]
    ).catch(async (error) => {
      if (!isMissingSchema(error)) throw error;
      return pool.query(`SELECT o.id, o.name, NULL::uuid AS parent_organization_id, 'member' AS access, $2::text AS role FROM organizations o WHERE o.id = $1`, [a.organizationId, a.role]);
    })).rows.filter((c: any) => orgs.includes(c.id));
    const facilities = (await pool.query(
      `SELECT p.id, p.name, p.state_code, p.county_fips, st.name AS state_name, co.name AS county_name,
              CASE WHEN pf.organization_id = ANY($1::uuid[]) THEN pf.organization_id END AS organization_id,
              COALESCE((SELECT array_agg(b.id) FROM buildings b WHERE b.property_id = p.id), '{}') AS building_ids
       FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
       LEFT JOIN us_states st ON st.code = p.state_code
       LEFT JOIN us_counties co ON co.fips = p.county_fips
       WHERE ${facilityAccessPredicateAny(1)} AND oi_private.caller_area_allows($2::uuid, p.id) ORDER BY st.name NULLS LAST, co.name NULLS LAST, p.name`, [orgs, a.userId]
    ).catch(async (error) => {
      if (!isMissingSchema(error)) throw error;
      return pool.query(
        `SELECT p.id, p.name, CASE WHEN pf.organization_id = ANY($1::uuid[]) THEN pf.organization_id END AS organization_id,
                COALESCE((SELECT array_agg(b.id) FROM buildings b WHERE b.property_id = p.id), '{}') AS building_ids
         FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
         WHERE ${facilityAccessPredicateAny(1)} ORDER BY p.name`, [orgs]);
    })).rows;
    res.set("Cache-Control", "no-store").json({
      active_organization_id: a.organizationId,
      tree: companies.length > 1,
      can_export_tree: await canExportTree(a.userId, a.organizationId),
      companies, facilities,
    });
  } catch (err: any) {
    console.error("OI locations", { outcome: "error", code: String(err?.code ?? "unknown") });
    res.status(500).json({ error: "internal_error" });
  }
});
