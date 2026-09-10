import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery } from "../db/tenantScope";

export const hardwareRouter = Router();
hardwareRouter.use(requireAuth);
hardwareRouter.use(enforceRolePermissions);
hardwareRouter.use(auditLog);

// Every hardware part's permanent tracker ID — generated server-side, exactly
// like openings.qr_token, and never accepted from the client. "TRK-" plus 8
// hex characters gives 4 billion+ combinations; collisions are astronomically
// unlikely at this scale, so (like qr_token) there's no retry-on-conflict loop.
function generateTrackerId(): string {
  return `TRK-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

// A hardware component is only reachable through an opening the caller's org owns,
// so every route here either takes opening_id directly or joins through it.
async function assertHardwareInOrg(hardwareId: string, orgId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT hc.opening_id FROM hardware_components hc
     WHERE hc.id = $1 AND hc.opening_id IN (${openingsForOrgSubquery(2)})`,
    [hardwareId, orgId]
  );
  return result.rows[0]?.opening_id ?? null;
}

const createHardwareSchema = z.object({
  opening_id: z.string().uuid(),
  component_type: z.enum([
    "lockset", "cylinder", "closer", "exit_device", "hinge",
    "automatic_operator", "panic_bar", "access_control_reader",
    "keypad", "electric_strike", "power_transfer", "maglock",
    "request_to_exit_device", "other",
  ]),
  manufacturer: z.string().optional(),
  model_number: z.string().optional(),
  finish: z.string().optional(),
  install_date: z.string().optional(),
  warranty_expiration: z.string().optional(),
  notes: z.string().optional(),
  unit_cost: z.number().min(0).optional(),
  supplier_name: z.string().optional(),
  supplier_contact: z.string().optional(),
  serial_number: z.string().optional(),
  carrier: z.string().optional(),
  tracking_number: z.string().optional(),
  shipment_status: z.enum(["not_shipped", "ordered", "shipped", "in_transit", "delivered", "installed", "other"]).optional(),
  expected_delivery_date: z.string().optional(),
  shipped_date: z.string().optional(),
  delivered_date: z.string().optional(),
});

hardwareRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const trackerId = generateTrackerId();
    const result = await pool.query(
      `INSERT INTO hardware_components
        (opening_id, component_type, manufacturer, model_number, finish, install_date, warranty_expiration, notes,
         unit_cost, supplier_name, supplier_contact, tracker_id, serial_number, carrier, tracking_number,
         shipment_status, expected_delivery_date, shipped_date, delivered_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        b.opening_id, b.component_type, b.manufacturer ?? null, b.model_number ?? null,
        b.finish ?? null, b.install_date ?? null, b.warranty_expiration ?? null, b.notes ?? null,
        b.unit_cost ?? null, b.supplier_name ?? null, b.supplier_contact ?? null,
        trackerId, b.serial_number ?? null, b.carrier ?? null, b.tracking_number ?? null,
        b.shipment_status ?? "not_shipped", b.expected_delivery_date ?? null,
        b.shipped_date ?? null, b.delivered_date ?? null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// List all hardware for a given opening
hardwareRouter.get("/by-opening/:openingId", async (req: AuthedRequest, res) => {
  const { openingId } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    if (!(await assertOpeningInOrg(openingId, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const result = await pool.query(
      "SELECT * FROM hardware_components WHERE opening_id = $1 ORDER BY install_date",
      [openingId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Portfolio-wide hardware search — this is what makes "find every Cal-Royal cylinder
// installed before 2019" a real query instead of a hypothetical in the pitch deck.
hardwareRouter.get("/", async (req: AuthedRequest, res) => {
  const { manufacturer, model_number, component_type, installed_before, installed_after } = req.query;
  const orgId = req.auth!.organizationId;
  const conditions: string[] = [];
  const values: any[] = [];

  if (manufacturer) {
    values.push(`%${manufacturer}%`);
    conditions.push(`manufacturer ILIKE $${values.length}`);
  }
  if (model_number) {
    values.push(`%${model_number}%`);
    conditions.push(`model_number ILIKE $${values.length}`);
  }
  if (component_type) {
    values.push(component_type);
    conditions.push(`component_type = $${values.length}`);
  }
  if (installed_before) {
    values.push(installed_before);
    conditions.push(`install_date <= $${values.length}`);
  }
  if (installed_after) {
    values.push(installed_after);
    conditions.push(`install_date >= $${values.length}`);
  }
  values.push(orgId);
  conditions.push(`opening_id IN (${openingsForOrgSubquery(values.length)})`);

  try {
    const result = await pool.query(
      `SELECT * FROM hardware_components WHERE ${conditions.join(" AND ")} ORDER BY install_date LIMIT 1000`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const updateHardwareSchema = createHardwareSchema.partial().omit({ opening_id: true });

hardwareRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  const parsed = updateHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const openingId = await assertHardwareInOrg(id, orgId);
    if (!openingId) return res.status(404).json({ error: "not_found" });

    const fields = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return res.status(400).json({ error: "no_fields_to_update" });

    const setClause = fields.map(([k], i) => `${k} = $${i + 1}`).join(", ");
    const values = fields.map(([, v]) => v);
    values.push(id);

    const result = await pool.query(
      `UPDATE hardware_components SET ${setClause} WHERE id = $${values.length} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

hardwareRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const openingId = await assertHardwareInOrg(id, orgId);
    if (!openingId) return res.status(404).json({ error: "not_found" });

    await pool.query("DELETE FROM hardware_components WHERE id = $1", [id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const bulkImportHardwareRowSchema = z.object({
  opening_code: z.string().min(1),
  component_type: z.enum([
    "lockset", "cylinder", "closer", "exit_device", "hinge",
    "automatic_operator", "panic_bar", "access_control_reader",
    "keypad", "electric_strike", "power_transfer", "maglock",
    "request_to_exit_device", "other",
  ]),
  manufacturer: z.string().optional(),
  model_number: z.string().optional(),
  finish: z.string().optional(),
  install_date: z.string().optional(),
  warranty_expiration: z.string().optional(),
  notes: z.string().optional(),
  unit_cost: z.number().min(0).optional(),
  supplier_name: z.string().optional(),
  supplier_contact: z.string().optional(),
  serial_number: z.string().optional(),
  carrier: z.string().optional(),
  tracking_number: z.string().optional(),
  shipment_status: z.enum(["not_shipped", "ordered", "shipped", "in_transit", "delivered", "installed", "other"]).optional(),
  expected_delivery_date: z.string().optional(),
  shipped_date: z.string().optional(),
  delivered_date: z.string().optional(),
});

const bulkImportHardwareSchema = z.object({
  rows: z.array(bulkImportHardwareRowSchema).min(1).max(1000),
});

// Bulk-attach hardware to existing openings from a CSV — deliberately a
// separate import from bulk-creating openings themselves. A real door
// commonly carries 5+ distinct parts (lockset, 3 hinges, closer, keypad,
// electric strike...), so "one row = one opening + one part" would mean
// repeating every opening's details across N rows per door. Instead, each
// row here references the opening by its human-readable opening_code —
// which is globally unique — so this doesn't even need a building_id: one
// CSV can attach parts to openings spanning any building or property the
// caller's org owns. Same per-row success/failure pattern as the openings
// bulk import, for the same reason (a few bad rows shouldn't sink the batch).
hardwareRouter.post("/bulk-import", async (req: AuthedRequest, res) => {
  const parsed = bulkImportHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { rows } = parsed.data;
  const orgId = req.auth!.organizationId;

  const results: Array<{
    row: number;
    opening_code: string;
    component_type: string;
    status: "created" | "error";
    id?: string;
    error?: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const openingResult = await pool.query(
        `SELECT id FROM openings WHERE opening_code = $1 AND id IN (${openingsForOrgSubquery(2)})`,
        [row.opening_code, orgId]
      );
      if (openingResult.rows.length === 0) {
        results.push({ row: i, opening_code: row.opening_code, component_type: row.component_type, status: "error", error: "opening_code not found" });
        continue;
      }
      const openingId = openingResult.rows[0].id;

      const trackerId = generateTrackerId();
      const insertResult = await pool.query(
        `INSERT INTO hardware_components
          (opening_id, component_type, manufacturer, model_number, finish, install_date, warranty_expiration, notes,
           unit_cost, supplier_name, supplier_contact, tracker_id, serial_number, carrier, tracking_number,
           shipment_status, expected_delivery_date, shipped_date, delivered_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [
          openingId, row.component_type, row.manufacturer ?? null, row.model_number ?? null,
          row.finish ?? null, row.install_date ?? null, row.warranty_expiration ?? null, row.notes ?? null,
          row.unit_cost ?? null, row.supplier_name ?? null, row.supplier_contact ?? null,
          trackerId, row.serial_number ?? null, row.carrier ?? null, row.tracking_number ?? null,
          row.shipment_status ?? "not_shipped", row.expected_delivery_date ?? null,
          row.shipped_date ?? null, row.delivered_date ?? null,
        ]
      );
      results.push({ row: i, opening_code: row.opening_code, component_type: row.component_type, status: "created", id: insertResult.rows[0].id });
    } catch (err) {
      console.error(err);
      results.push({ row: i, opening_code: row.opening_code, component_type: row.component_type, status: "error", error: "insert_failed" });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  res.status(207).json({
    total: rows.length,
    created,
    failed: rows.length - created,
    results,
  });
});
