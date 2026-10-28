import { Router, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { facilityScheduleAccess } from "../db/tenantScope";
import { COMPARISON_ENGINE_VERSION, compareImport, comparisonCsv } from "../services/scheduleComparison";

// M4: schedule vs field comparison snapshots.
// Who: admin, facilities_manager, technician and inspector of the facility owner
// org or an actively assigned provider org (viewer: 403; other orgs: 404).
// Technicians and inspectors may also RUN a comparison: it only reads field and
// schedule data and appends a read-only snapshot, so it changes nothing they
// could not already see. CSV export always comes from a stored snapshot.
export const COMPARISON_ROLES = ["admin", "facilities_manager", "technician", "inspector"];
export const scheduleComparisonsRouter = Router();
scheduleComparisonsRouter.use(requireAuth, auditLog);
const uuid = z.string().uuid();
let enabled = false;
async function snapshotsEnabled(): Promise<boolean> {
  if (enabled) return true;
  enabled = Boolean((await pool.query("SELECT to_regclass('public.schedule_comparison_snapshots') IS NOT NULL AS ok")).rows[0]?.ok);
  return enabled;
}
async function guard(req: AuthedRequest, res: Response): Promise<boolean> {
  if (!COMPARISON_ROLES.includes(req.auth!.role)) { res.status(403).json({ error: "insufficient_role_for_action" }); return false; }
  if (!(await snapshotsEnabled())) { res.status(503).json({ error: "comparisons_unavailable" }); return false; }
  return true;
}
async function accessibleImport(req: AuthedRequest, id: string) {
  if (!uuid.safeParse(id).success) return null;
  const imp = (await pool.query("SELECT i.id, i.property_id, i.building_id, i.status, b.name AS building_name FROM schedule_imports i JOIN buildings b ON b.id=i.building_id WHERE i.id=$1", [id])).rows[0];
  if (!imp) return null;
  return (await facilityScheduleAccess(pool, imp.property_id, req.auth!.organizationId)) ? imp : null;
}
const LIST_COLS = `s.id, s.import_id, s.engine_version, s.summary, s.opening_count, s.line_count, s.created_at, s.created_by_role, u.full_name AS created_by_name`;
async function accessibleSnapshot(req: AuthedRequest, id: string, full: boolean) {
  if (!uuid.safeParse(id).success) return null;
  const s = (await pool.query(`SELECT ${LIST_COLS}, s.property_id, b.name AS building_name${full ? ", s.results" : ""}
    FROM schedule_comparison_snapshots s LEFT JOIN users u ON u.id=s.created_by_user_id JOIN buildings b ON b.id=s.building_id WHERE s.id=$1`, [id])).rows[0];
  if (!s) return null;
  return (await facilityScheduleAccess(pool, s.property_id, req.auth!.organizationId)) ? s : null;
}
const strip = ({ property_id, ...rest }: any) => rest;

scheduleComparisonsRouter.post("/by-import/:importId", async (req: AuthedRequest, res: Response) => {
  if (!(await guard(req, res))) return;
  const imp = await accessibleImport(req, req.params.importId);
  if (!imp) return res.status(404).json({ error: "not_found" });
  if (imp.status !== "confirmed") return res.status(409).json({ error: "import_not_confirmed" });
  const result = await compareImport(pool, imp.id);
  if (!result) return res.status(404).json({ error: "not_found" });
  const id = randomUUID();
  const lines = result.openings.reduce((n, o) => n + o.lines.length, 0);
  await pool.query(`INSERT INTO schedule_comparison_snapshots(id, import_id, property_id, building_id, engine_version, summary, results, opening_count, line_count, created_by_user_id, created_by_organization_id, created_by_role)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)`,
    [id, imp.id, imp.property_id, imp.building_id, COMPARISON_ENGINE_VERSION, JSON.stringify(result.summary), JSON.stringify(result.openings), result.openings.length, lines, req.auth!.userId, req.auth!.organizationId, req.auth!.role]);
  const s = await accessibleSnapshot(req, id, false);
  res.status(201).json(strip(s));
});

scheduleComparisonsRouter.get("/by-import/:importId", async (req: AuthedRequest, res: Response) => {
  if (!(await guard(req, res))) return;
  const imp = await accessibleImport(req, req.params.importId);
  if (!imp) return res.status(404).json({ error: "not_found" });
  const r = await pool.query(`SELECT ${LIST_COLS} FROM schedule_comparison_snapshots s LEFT JOIN users u ON u.id=s.created_by_user_id WHERE s.import_id=$1 ORDER BY s.created_at DESC, s.id LIMIT 200`, [imp.id]);
  res.json({ import: { id: imp.id, status: imp.status, building_name: imp.building_name }, snapshots: r.rows });
});

scheduleComparisonsRouter.get("/:id", async (req: AuthedRequest, res: Response) => {
  if (!(await guard(req, res))) return;
  const s = await accessibleSnapshot(req, req.params.id, true);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json(strip(s));
});

scheduleComparisonsRouter.get("/:id/csv", async (req: AuthedRequest, res: Response) => {
  if (!(await guard(req, res))) return;
  const s = await accessibleSnapshot(req, req.params.id, true);
  if (!s) return res.status(404).json({ error: "not_found" });
  const day = new Date(s.created_at).toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="schedule-comparison-${day}-${String(s.id).slice(0, 8)}.csv"`);
  res.send(comparisonCsv(s.import_id, s.building_name, { openings: s.results }));
});