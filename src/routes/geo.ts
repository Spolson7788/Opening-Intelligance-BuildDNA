import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole, AuthedRequest } from "../middleware/auth";
import { facilityAccessPredicate } from "../db/tenantScope";

// Geographic state and county reference data, plus the coverage a provider
// branch or technician is assigned. Company "locations" in the sidebar are a
// different thing (the company tree). These routes are states and counties.
export const geoRouter = Router();
geoRouter.use(requireAuth);

const stateCode = z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase());
const countyFips = z.string().regex(/^\d{5}$/);
const areaBody = z.object({
  state_code: stateCode,
  county_fips: countyFips.nullable().optional(),
});

function constraintStatus(err: { code?: string; message?: string }, res: { status: (n: number) => { json: (b: unknown) => void } }): boolean {
  if (err?.code !== "23514") return false;
  const message = String(err.message);
  const names = ["assignment_would_be_out_of_area", "out_of_area", "county_not_in_state"];
  const hit = names.find((name) => message.includes(name));
  if (!hit) return false;
  const status = hit === "county_not_in_state" ? 400 : 409;
  res.status(status).json({ error: hit });
  return true;
}

geoRouter.get("/states", async (_req: AuthedRequest, res) => {
  try {
    const result = await pool.query("SELECT code, name FROM us_states ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

geoRouter.get("/counties", async (req: AuthedRequest, res) => {
  const parsed = z.object({ state_code: stateCode }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "state_code is required" });
  try {
    const result = await pool.query(
      "SELECT fips, state_code, name FROM us_counties WHERE state_code = $1 ORDER BY name",
      [parsed.data.state_code]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

geoRouter.get("/coverage", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;
  try {
    const facilities = await pool.query(
      `SELECT p.id, p.name, p.city, p.state_code, p.county_fips, s.name AS state_name, c.name AS county_name
       FROM properties p
       JOIN portfolios pf ON pf.id = p.portfolio_id
       LEFT JOIN us_states s ON s.code = p.state_code
       LEFT JOIN us_counties c ON c.fips = p.county_fips
       WHERE ${facilityAccessPredicate(1)} AND oi_private.caller_area_allows($2::uuid, p.id)
       ORDER BY s.name NULLS LAST, c.name NULLS LAST, p.name`,
      [orgId, userId]
    );
    const branches = await pool.query(
      `SELECT b.id, b.name, b.default_state,
              COALESCE(json_agg(json_build_object('id', a.id, 'state_code', a.state_code, 'county_fips', a.county_fips, 'state_name', s.name, 'county_name', c.name) ORDER BY s.name, c.name)
                FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS areas
       FROM company_branches b
       LEFT JOIN company_branch_areas a ON a.branch_id = b.id
       LEFT JOIN us_states s ON s.code = a.state_code
       LEFT JOIN us_counties c ON c.fips = a.county_fips
       WHERE b.organization_id = $1
       GROUP BY b.id
       ORDER BY b.name`,
      [orgId]
    );
    const technicians = await pool.query(
      `SELECT u.id, u.full_name, u.role, uba.branch_id,
              COALESCE(json_agg(json_build_object('id', t.id, 'state_code', t.state_code, 'county_fips', t.county_fips, 'state_name', s.name, 'county_name', c.name) ORDER BY s.name, c.name)
                FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS areas
       FROM users u
       LEFT JOIN user_branch_assignments uba ON uba.user_id = u.id
       LEFT JOIN technician_areas t ON t.user_id = u.id
       LEFT JOIN us_states s ON s.code = t.state_code
       LEFT JOIN us_counties c ON c.fips = t.county_fips
       WHERE u.organization_id = $1 AND u.role = 'technician' AND u.is_active
       GROUP BY u.id, uba.branch_id
       ORDER BY u.full_name`,
      [orgId]
    );
    const assignments = await pool.query(
      `SELECT a.property_id, a.provider_organization_id, p.name AS property_name,
              p.state_code, p.county_fips, s.name AS state_name, c.name AS county_name, org.name AS provider_name
       FROM facility_provider_assignments a
       JOIN properties p ON p.id = a.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       JOIN organizations org ON org.id = a.provider_organization_id
       LEFT JOIN us_states s ON s.code = p.state_code
       LEFT JOIN us_counties c ON c.fips = p.county_fips
       WHERE a.revoked_at IS NULL AND (pf.organization_id = $1 OR a.provider_organization_id = $1)
       ORDER BY s.name NULLS LAST, c.name NULLS LAST, p.name`,
      [orgId]
    );
    res.json({
      facilities: facilities.rows,
      branches: branches.rows,
      technicians: technicians.rows,
      assignments: assignments.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

geoRouter.patch("/facilities/:id", requireRole("admin", "facilities_manager"), async (req: AuthedRequest, res) => {
  const parsed = z.object({
    state_code: stateCode.nullable(),
    county_fips: countyFips.nullable(),
  }).safeParse(req.body);
  if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: "invalid_location" });
  }
  try {
    const owned = await pool.query(
      `SELECT 1 FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE p.id = $1 AND pf.organization_id = $2`,
      [req.params.id, req.auth!.organizationId]
    );
    if (owned.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const result = await pool.query(
      `UPDATE properties SET state_code = $1, county_fips = $2, state = COALESCE($1, state) WHERE id = $3
       RETURNING id, name, state, state_code, county_fips`,
      [parsed.data.state_code, parsed.data.county_fips, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (constraintStatus(err, res)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

geoRouter.post("/branches/:id/areas", requireRole("admin"), async (req: AuthedRequest, res) => {
  const parsed = areaBody.safeParse(req.body);
  if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: "invalid_area" });
  }
  try {
    const branch = await pool.query(
      "SELECT id FROM company_branches WHERE id = $1 AND organization_id = $2",
      [req.params.id, req.auth!.organizationId]
    );
    if (branch.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const result = await pool.query(
      `INSERT INTO company_branch_areas (branch_id, state_code, county_fips) VALUES ($1, $2, $3)
       RETURNING id, branch_id, state_code, county_fips`,
      [req.params.id, parsed.data.state_code, parsed.data.county_fips ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "already_exists" });
    if (constraintStatus(err, res)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

geoRouter.delete("/branches/:id/areas/:areaId", requireRole("admin"), async (req: AuthedRequest, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM company_branch_areas a USING company_branches b
       WHERE a.id = $1 AND a.branch_id = $2 AND b.id = a.branch_id AND b.organization_id = $3
       RETURNING a.id`,
      [req.params.areaId, req.params.id, req.auth!.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

geoRouter.post("/technicians/:userId/areas", requireRole("admin"), async (req: AuthedRequest, res) => {
  const parsed = areaBody.safeParse(req.body);
  if (!parsed.success || !z.string().uuid().safeParse(req.params.userId).success) {
    return res.status(400).json({ error: "invalid_area" });
  }
  try {
    const tech = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = 'technician'",
      [req.params.userId, req.auth!.organizationId]
    );
    if (tech.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const result = await pool.query(
      `INSERT INTO technician_areas (user_id, state_code, county_fips) VALUES ($1, $2, $3)
       RETURNING id, user_id, state_code, county_fips`,
      [req.params.userId, parsed.data.state_code, parsed.data.county_fips ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "already_exists" });
    if (constraintStatus(err, res)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

geoRouter.delete("/technicians/:userId/areas/:areaId", requireRole("admin"), async (req: AuthedRequest, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM technician_areas t USING users u
       WHERE t.id = $1 AND t.user_id = $2 AND u.id = t.user_id AND u.organization_id = $3
       RETURNING t.id`,
      [req.params.areaId, req.params.userId, req.auth!.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
