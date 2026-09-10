import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery } from "../db/tenantScope";
import { checkAndGenerateDueWorkOrders } from "./maintenanceSchedulesRoute";

export const workOrdersRouter = Router();
workOrdersRouter.use(requireAuth);
workOrdersRouter.use(enforceRolePermissions);
workOrdersRouter.use(auditLog);

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

const WORK_ORDER_SELECT = `
  SELECT wo.*, o.opening_code, b.name AS building_name, p.name AS property_name, p.id AS property_id,
         assignee.full_name AS assigned_to_name, assignee.email AS assigned_to_email,
         creator.full_name AS created_by_name
  FROM work_orders wo
  JOIN openings o ON o.id = wo.opening_id
  JOIN buildings b ON b.id = o.building_id
  JOIN properties p ON p.id = b.property_id
  LEFT JOIN users assignee ON assignee.id = wo.assigned_to_user_id
  JOIN users creator ON creator.id = wo.created_by_user_id
`;

const createSchema = z.object({
  opening_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  due_date: z.string().optional(),
  assigned_to_user_id: z.string().uuid().optional(),
});

// Creating and assigning work is a management decision — same reasoning as
// why creating openings/properties is admin/facilities_manager-only.
// Updating the STATUS of work already assigned to you is different, and
// handled by the narrower endpoint below.
workOrdersRouter.post("/", requireRole("admin", "facilities_manager"), async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (b.assigned_to_user_id) {
      const assigneeCheck = await pool.query(
        "SELECT 1 FROM users WHERE id = $1 AND organization_id = $2",
        [b.assigned_to_user_id, orgId]
      );
      if (assigneeCheck.rows.length === 0) return res.status(400).json({ error: "invalid_assignee" });
    }

    const result = await pool.query(
      `INSERT INTO work_orders (opening_id, title, description, priority, due_date, assigned_to_user_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.opening_id, b.title, b.description ?? null, b.priority, b.due_date ?? null, b.assigned_to_user_id ?? null, userId]
    );

    const full = await pool.query(`${WORK_ORDER_SELECT} WHERE wo.id = $1`, [result.rows[0].id]);
    res.status(201).json(full.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Open/in-progress work sorts first and by urgency; done/cancelled work
// sorts to the bottom — the list is meant to answer "what's outstanding
// right now," not just "everything in creation order."
workOrdersRouter.get("/", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;
  // Lazy generation: no real background scheduler runs in this app, so any
  // due recurring maintenance gets checked and generated right here,
  // before the list is returned — the same function a real production
  // cron would call via POST /generate-due, just triggered on read instead
  // of on a timer.
  await checkAndGenerateDueWorkOrders(orgId).catch((err) => console.error("due-schedule check failed:", err));

  const { status, assigned_to_user_id, property_id } = req.query;

  const conditions = [`pf.organization_id = $1`];
  const values: any[] = [orgId];

  if (status && typeof status === "string") {
    values.push(status);
    conditions.push(`wo.status = $${values.length}`);
  }
  if (assigned_to_user_id && typeof assigned_to_user_id === "string") {
    values.push(assigned_to_user_id);
    conditions.push(`wo.assigned_to_user_id = $${values.length}`);
  }
  if (property_id && typeof property_id === "string") {
    values.push(property_id);
    conditions.push(`p.id = $${values.length}`);
  }

  try {
    const result = await pool.query(
      `${WORK_ORDER_SELECT}
       JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY
         CASE WHEN wo.status IN ('open','in_progress') THEN 0 ELSE 1 END,
         CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         wo.due_date ASC NULLS LAST,
         wo.created_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

async function fetchWorkOrderInOrg(id: string, orgId: string) {
  const result = await pool.query(
    `${WORK_ORDER_SELECT} JOIN portfolios pf ON pf.id = p.portfolio_id WHERE wo.id = $1 AND pf.organization_id = $2`,
    [id, orgId]
  );
  return result.rows[0] ?? null;
}

workOrdersRouter.get("/:id", async (req: AuthedRequest, res) => {
  const wo = await fetchWorkOrderInOrg(req.params.id, req.auth!.organizationId);
  if (!wo) return res.status(404).json({ error: "not_found" });
  res.json(wo);
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  due_date: z.string().nullable().optional(),
  assigned_to_user_id: z.string().uuid().nullable().optional(),
  status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
});

// Full update — reassigning, rescheduling, changing priority — stays
// admin/facilities_manager-only, same reasoning as creation.
workOrdersRouter.patch("/:id", requireRole("admin", "facilities_manager"), async (req: AuthedRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;

  const existing = await fetchWorkOrderInOrg(req.params.id, orgId);
  if (!existing) return res.status(404).json({ error: "not_found" });

  if (b.assigned_to_user_id) {
    const assigneeCheck = await pool.query("SELECT 1 FROM users WHERE id = $1 AND organization_id = $2", [b.assigned_to_user_id, orgId]);
    if (assigneeCheck.rows.length === 0) return res.status(400).json({ error: "invalid_assignee" });
  }

  const setClauses: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(b)) {
    values.push(val);
    setClauses.push(`${key} = $${values.length}`);
  }
  if (b.status !== undefined) {
    setClauses.push(b.status === "done" ? `completed_at = now()` : `completed_at = NULL`);
  }
  if (setClauses.length === 0) return res.status(400).json({ error: "no_fields_to_update" });

  values.push(req.params.id);
  try {
    await pool.query(`UPDATE work_orders SET ${setClauses.join(", ")} WHERE id = $${values.length}`, values);
    const updated = await fetchWorkOrderInOrg(req.params.id, orgId);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const statusOnlySchema = z.object({
  status: z.enum(["open", "in_progress", "done", "cancelled"]),
});

// Narrower endpoint any field role can use — updating just the status of a
// work order actually assigned to them, without giving them the ability to
// reassign work, change its priority, or touch anyone else's task. A
// technician marking their own job "in progress" or "done" is real field
// work; letting them reassign or reprioritize work orders is not.
workOrdersRouter.post("/:id/status", async (req: AuthedRequest, res) => {
  const parsed = statusOnlySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;
  const role = req.auth!.role;

  const existing = await fetchWorkOrderInOrg(req.params.id, orgId);
  if (!existing) return res.status(404).json({ error: "not_found" });

  const isManagement = role === "admin" || role === "facilities_manager";
  if (!isManagement && existing.assigned_to_user_id !== userId) {
    return res.status(403).json({ error: "not_assigned_to_you" });
  }

  const completedClause = parsed.data.status === "done" ? ", completed_at = now()" : ", completed_at = NULL";
  try {
    await pool.query(`UPDATE work_orders SET status = $1${completedClause} WHERE id = $2`, [parsed.data.status, req.params.id]);
    const updated = await fetchWorkOrderInOrg(req.params.id, orgId);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
