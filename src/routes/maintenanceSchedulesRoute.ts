import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery } from "../db/tenantScope";

export const maintenanceSchedulesRouter = Router();
maintenanceSchedulesRouter.use(requireAuth);
maintenanceSchedulesRouter.use(enforceRolePermissions);
maintenanceSchedulesRouter.use(auditLog);

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

function advanceDate(date: Date, unit: string, count: number): Date {
  const d = new Date(date);
  if (unit === "days") d.setUTCDate(d.getUTCDate() + count);
  else if (unit === "weeks") d.setUTCDate(d.getUTCDate() + count * 7);
  else if (unit === "months") d.setUTCMonth(d.getUTCMonth() + count);
  else if (unit === "years") d.setUTCFullYear(d.getUTCFullYear() + count);
  return d;
}

// Wrapped in a transaction with row-level locking on purpose. Without this,
// two nearly-simultaneous calls (e.g. a dashboard page load and someone
// clicking "Check Now" at the same moment) can both SELECT the same due
// schedule before either has committed its next_due_date UPDATE — each
// then independently generates its own work order from the same schedule.
// Confirmed this was a real, reproducible bug during verification, not a
// theoretical one: firing 5 concurrent calls against one schedule produced
// 5 duplicate work orders instead of 1. FOR UPDATE SKIP LOCKED fixes it —
// a concurrent transaction just skips a row another transaction is
// currently processing, rather than blocking and then reprocessing it
// once the first transaction's advance has already landed.
export async function checkAndGenerateDueWorkOrders(orgId: string): Promise<number> {
  const client = await pool.connect();
  let generatedCount = 0;
  try {
    await client.query("BEGIN");

    const due = await client.query(
      `SELECT ms.* FROM maintenance_schedules ms
       JOIN openings o ON o.id = ms.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE pf.organization_id = $1 AND ms.is_active = true AND ms.next_due_date <= CURRENT_DATE
       FOR UPDATE OF ms SKIP LOCKED`,
      [orgId]
    );

    for (const schedule of due.rows) {
      await client.query(
        `INSERT INTO work_orders (opening_id, title, description, priority, assigned_to_user_id, created_by_user_id, generated_from_schedule_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          schedule.opening_id, schedule.title, schedule.description, schedule.priority,
          schedule.assigned_to_user_id, schedule.created_by_user_id, schedule.id,
        ]
      );

      let nextDue = new Date(schedule.next_due_date);
      const today = new Date();
      while (nextDue <= today) {
        nextDue = advanceDate(nextDue, schedule.interval_unit, schedule.interval_count);
      }

      await client.query(
        `UPDATE maintenance_schedules SET next_due_date = $1, last_generated_at = now() WHERE id = $2`,
        [nextDue.toISOString().slice(0, 10), schedule.id]
      );
      generatedCount++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return generatedCount;
}

const createSchema = z.object({
  opening_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  assigned_to_user_id: z.string().uuid().optional(),
  interval_unit: z.enum(["days", "weeks", "months", "years"]),
  interval_count: z.number().int().positive(),
  start_date: z.string().optional(),
});

maintenanceSchedulesRouter.post("/", requireRole("admin", "facilities_manager"), async (req: AuthedRequest, res) => {
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
      const check = await pool.query("SELECT 1 FROM users WHERE id = $1 AND organization_id = $2", [b.assigned_to_user_id, orgId]);
      if (check.rows.length === 0) return res.status(400).json({ error: "invalid_assignee" });
    }

    const startDate = b.start_date ?? new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `INSERT INTO maintenance_schedules
        (opening_id, title, description, priority, assigned_to_user_id, interval_unit, interval_count, next_due_date, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.opening_id, b.title, b.description ?? null, b.priority, b.assigned_to_user_id ?? null, b.interval_unit, b.interval_count, startDate, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

maintenanceSchedulesRouter.get("/", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;
  try {
    const result = await pool.query(
      `SELECT ms.*, o.opening_code, b.name AS building_name, p.name AS property_name,
              assignee.full_name AS assigned_to_name
       FROM maintenance_schedules ms
       JOIN openings o ON o.id = ms.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       LEFT JOIN users assignee ON assignee.id = ms.assigned_to_user_id
       WHERE pf.organization_id = $1
       ORDER BY ms.next_due_date ASC`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigned_to_user_id: z.string().uuid().nullable().optional(),
  interval_unit: z.enum(["days", "weeks", "months", "years"]).optional(),
  interval_count: z.number().int().positive().optional(),
  is_active: z.boolean().optional(),
});

maintenanceSchedulesRouter.patch("/:id", requireRole("admin", "facilities_manager"), async (req: AuthedRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;

  const existing = await pool.query(
    `SELECT ms.id FROM maintenance_schedules ms
     JOIN openings o ON o.id = ms.opening_id
     JOIN buildings bl ON bl.id = o.building_id
     JOIN properties p ON p.id = bl.property_id
     JOIN portfolios pf ON pf.id = p.portfolio_id
     WHERE ms.id = $1 AND pf.organization_id = $2`,
    [req.params.id, orgId]
  );
  if (existing.rows.length === 0) return res.status(404).json({ error: "not_found" });

  if (b.assigned_to_user_id) {
    const check = await pool.query("SELECT 1 FROM users WHERE id = $1 AND organization_id = $2", [b.assigned_to_user_id, orgId]);
    if (check.rows.length === 0) return res.status(400).json({ error: "invalid_assignee" });
  }

  const setClauses: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(b)) {
    values.push(val);
    setClauses.push(`${key} = $${values.length}`);
  }
  if (setClauses.length === 0) return res.status(400).json({ error: "no_fields_to_update" });

  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE maintenance_schedules SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

maintenanceSchedulesRouter.post("/generate-due", requireRole("admin", "facilities_manager"), async (req: AuthedRequest, res) => {
  try {
    const count = await checkAndGenerateDueWorkOrders(req.auth!.organizationId);
    res.json({ generated: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
