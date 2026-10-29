import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";

// OI staff read access (multi-company design, part B): READ ONLY overviews by facility and by
// service-provider company. Staff status is re-checked in the database on every request
// (is_platform_staff: active platform_staff row + active account + active internal membership).
// Nothing here writes, and no other company's users can reach it.
export const platformRouter = Router();

platformRouter.use(requireAuth, async (req: AuthedRequest, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const r = await pool.query("SELECT is_platform_staff($1) AS staff", [req.auth!.userId]);
    if (r.rows[0]?.staff !== true) return res.status(403).json({ error: "forbidden" });
    return next();
  } catch {
    return res.status(503).json({ error: "authorization_service_unavailable" });
  }
});

platformRouter.get("/facilities", async (_req, res) => {
  try {
    const r = await pool.query(`SELECT property_id, property_name, state, owner_organization_id, owner_name, top_organization_id,
      active_provider_ids, building_count::int, opening_count::int FROM platform_facility_overview ORDER BY owner_name, property_name LIMIT 1000`);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

platformRouter.get("/providers", async (_req, res) => {
  try {
    const r = await pool.query(`SELECT provider_organization_id, provider_name, active_facility_count::int, active_property_ids
      FROM platform_provider_overview ORDER BY provider_name LIMIT 1000`);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});
