import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery } from "../db/tenantScope";

export const eventsRouter = Router();
eventsRouter.use(requireAuth);
eventsRouter.use(enforceRolePermissions);
eventsRouter.use(auditLog);

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

const serviceEventSchema = z.object({
  opening_id: z.string().uuid(),
  hardware_component_id: z.string().uuid().optional(),
  performed_by_org_id: z.string().uuid().optional(),
  event_date: z.string(),
  work_performed: z.string().min(1),
  parts_used: z.array(z.string()).optional(),
  cost: z.number().optional(),
});

eventsRouter.post("/service-events", async (req: AuthedRequest, res) => {
  const parsed = serviceEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const result = await pool.query(
      `INSERT INTO service_events
        (opening_id, hardware_component_id, performed_by_org_id, performed_by_user_id, event_date, work_performed, parts_used, cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        b.opening_id, b.hardware_component_id ?? null, b.performed_by_org_id ?? null,
        userId, b.event_date, b.work_performed, b.parts_used ?? [], b.cost ?? null,
      ]
    );
    await pool.query(
      `UPDATE openings SET last_service_date = GREATEST(COALESCE(last_service_date, $1), $1) WHERE id = $2`,
      [b.event_date, b.opening_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const inspectionEventSchema = z.object({
  opening_id: z.string().uuid(),
  event_date: z.string(),
  inspection_type: z.enum(["general", "fire_door_nfpa80", "ada_compliance", "access_control"]),
  checklist_result: z.record(z.any()).optional(),
  passed: z.boolean(),
  notes: z.string().optional(),
  signature_data: z.string().max(500_000).optional(), // a simple line-drawing PNG data URL is a few KB; 500KB is a generous sanity cap, not a real limit
  signed_by_name: z.string().optional(),
});

eventsRouter.post("/inspection-events", async (req: AuthedRequest, res) => {
  const parsed = inspectionEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const result = await pool.query(
      `INSERT INTO inspection_events
        (opening_id, performed_by_user_id, event_date, inspection_type, checklist_result, passed, notes,
         signature_data, signed_by_name, signed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        b.opening_id, userId, b.event_date, b.inspection_type, b.checklist_result ?? {}, b.passed, b.notes ?? null,
        b.signature_data ?? null, b.signed_by_name ?? null, b.signature_data ? new Date().toISOString() : null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
