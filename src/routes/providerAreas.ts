import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { respondToConstraint } from "../db/constraintError";

export const providerRouter = Router();
providerRouter.use(requireAuth);
providerRouter.use(enforceRolePermissions);
providerRouter.use(auditLog);

const stateCode = z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase());
const countyFips = z.string().regex(/^\d{5}$/);

const areaSchema = z.object({
  state_code: stateCode,
  county_fips: countyFips.nullable().optional(),
});

async function flag(sql: string, params: unknown[]): Promise<boolean> {
  const result = await pool.query(sql, params);
  return result.rows[0]?.allowed === true;
}

providerRouter.get("/branches", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;
  try {
    const org = await pool.query("SELECT org_type FROM organizations WHERE id = $1", [orgId]);
    if (org.rows[0]?.org_type !== "service_partner") {
      return res.status(403).json({ error: "provider_org_required" });
    }
    const result = await pool.query(
      `SELECT b.id, b.name, b.created_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', a.id,
                    'state_code', a.state_code,
                    'county_fips', a.county_fips,
                    'state_name', s.name,
                    'county_name', c.name
                  )
                  ORDER BY s.name, c.name
                ) FILTER (WHERE a.id IS NOT NULL),
                '[]'::json
              ) AS areas
       FROM provider_branches b
       LEFT JOIN provider_branch_areas a ON a.branch_id = b.id
       LEFT JOIN us_states s ON s.code = a.state_code
       LEFT JOIN us_counties c ON c.fips = a.county_fips
       WHERE b.organization_id = $1
       GROUP BY b.id
       ORDER BY b.name`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

providerRouter.post("/branches", async (req: AuthedRequest, res) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = req.auth!.userId;
  const orgId = req.auth!.organizationId;
  try {
    const allowed = await flag(
      `SELECT oi_private.can_manage_provider_org($1::uuid, $2::uuid) AS allowed`,
      [userId, orgId]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      `INSERT INTO provider_branches (organization_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
      [orgId, parsed.data.name]
    );
    res.status(201).json({ ...result.rows[0], areas: [] });
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

providerRouter.post("/branches/:branchId/areas", async (req: AuthedRequest, res) => {
  const parsed = areaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = req.auth!.userId;
  const { branchId } = req.params;
  try {
    const branch = await pool.query(
      "SELECT organization_id FROM provider_branches WHERE id = $1",
      [branchId]
    );
    if (branch.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const allowed = await flag(
      `SELECT oi_private.can_manage_provider_org($1::uuid, $2::uuid) AS allowed`,
      [userId, branch.rows[0].organization_id]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      `INSERT INTO provider_branch_areas (branch_id, state_code, county_fips)
       VALUES ($1, $2, $3)
       RETURNING id, state_code, county_fips`,
      [branchId, parsed.data.state_code, parsed.data.county_fips ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

providerRouter.delete("/branches/:branchId/areas/:areaId", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { branchId, areaId } = req.params;
  try {
    const branch = await pool.query(
      "SELECT organization_id FROM provider_branches WHERE id = $1",
      [branchId]
    );
    if (branch.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const allowed = await flag(
      `SELECT oi_private.can_manage_provider_org($1::uuid, $2::uuid) AS allowed`,
      [userId, branch.rows[0].organization_id]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      "DELETE FROM provider_branch_areas WHERE id = $1 AND branch_id = $2 RETURNING id",
      [areaId, branchId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

providerRouter.put("/technicians/:userId/branch", async (req: AuthedRequest, res) => {
  const parsed = z.object({ branch_id: z.string().uuid().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const actorId = req.auth!.userId;
  const { userId } = req.params;
  try {
    const allowed = await flag(
      `SELECT oi_private.can_manage_technician($1::uuid, $2::uuid) AS allowed`,
      [actorId, userId]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      `UPDATE users SET provider_branch_id = $1 WHERE id = $2
       RETURNING id, full_name, role, provider_branch_id`,
      [parsed.data.branch_id, userId]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

providerRouter.post("/technicians/:userId/areas", async (req: AuthedRequest, res) => {
  const parsed = areaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const actorId = req.auth!.userId;
  const { userId } = req.params;
  try {
    const allowed = await flag(
      `SELECT oi_private.can_manage_technician($1::uuid, $2::uuid) AS allowed`,
      [actorId, userId]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      `INSERT INTO technician_areas (user_id, state_code, county_fips)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, state_code, county_fips`,
      [userId, parsed.data.state_code, parsed.data.county_fips ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

providerRouter.delete("/technicians/:userId/areas/:areaId", async (req: AuthedRequest, res) => {
  const actorId = req.auth!.userId;
  const { userId, areaId } = req.params;
  try {
    const allowed = await flag(
      `SELECT oi_private.can_manage_technician($1::uuid, $2::uuid) AS allowed`,
      [actorId, userId]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      "DELETE FROM technician_areas WHERE id = $1 AND user_id = $2 RETURNING id",
      [areaId, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const assignmentSchema = z.object({
  property_id: z.string().uuid(),
  provider_organization_id: z.string().uuid(),
  provider_branch_id: z.string().uuid().nullable().optional(),
});

providerRouter.post("/assignments", async (req: AuthedRequest, res) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = req.auth!.userId;
  const body = parsed.data;
  try {
    const allowed = await flag(
      `SELECT oi_private.can_manage_assignment($1::uuid, $2::uuid, $3::uuid) AS allowed`,
      [userId, body.property_id, body.provider_organization_id]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      `INSERT INTO facility_provider_assignments
         (property_id, provider_organization_id, provider_branch_id)
       VALUES ($1, $2, $3)
       RETURNING id, property_id, provider_organization_id, provider_branch_id, created_at`,
      [body.property_id, body.provider_organization_id, body.provider_branch_id ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

providerRouter.delete("/assignments/:id", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  try {
    const existing = await pool.query(
      `SELECT property_id, provider_organization_id FROM facility_provider_assignments WHERE id = $1`,
      [req.params.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const row = existing.rows[0];
    const allowed = await flag(
      `SELECT oi_private.can_manage_assignment($1::uuid, $2::uuid, $3::uuid) AS allowed`,
      [userId, row.property_id, row.provider_organization_id]
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });
    await pool.query("DELETE FROM facility_provider_assignments WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err: any) {
    if (respondToConstraint(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
