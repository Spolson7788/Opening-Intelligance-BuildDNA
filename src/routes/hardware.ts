import { revisionConflict } from "../services/revision";
import { canonicalPayloadHash, findSyncReceipt, writeSyncReceiptAndAudit } from "../services/syncProtocol";
import { Router } from "express";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
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
  id: z.string().uuid().optional(),
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
  mounting_scope: z.enum(["opening", "frame", "door_leaf"]).optional(),
  door_leaf_id: z.string().uuid().optional(),
  frame_id: z.string().uuid().optional(),
  position_label: z.string().optional(),
  client_operation_id: z.string().uuid().optional(),
  condition: z.enum(["good", "worn", "failed", "unverified"]).optional(),
  identity_status: z.enum(["established", "unresolved"]).optional(),
  review_state: z.enum(["pending", "reviewed"]).optional(),
  replacement_required: z.boolean().optional(),
});

async function validateMountingTarget(
  openingId: string,
  mountingScope: "opening" | "frame" | "door_leaf",
  doorLeafId?: string,
  frameId?: string,
  queryable: Pick<typeof pool, "query"> = pool
): Promise<string | null> {
  if (mountingScope === "door_leaf") {
    if (!doorLeafId || frameId) return "door_leaf_target_required";
    const leaf = await queryable.query("SELECT 1 FROM door_leaves WHERE id=$1 AND opening_id=$2", [doorLeafId, openingId]);
    if (!leaf.rows.length) return "door_leaf_not_in_opening";
  } else if (mountingScope === "frame") {
    if (!frameId || doorLeafId) return "frame_target_required";
    const frame = await queryable.query("SELECT 1 FROM opening_frames WHERE id=$1 AND opening_id=$2", [frameId, openingId]);
    if (!frame.rows.length) return "frame_not_in_opening";
  } else if (doorLeafId || frameId) {
    return "opening_scope_cannot_have_leaf_or_frame";
  }
  return null;
}

hardwareRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await client.query(`SELECT id FROM openings WHERE id=$1 AND id IN (${openingsForOrgSubquery(2)}) FOR UPDATE`, [b.opening_id, orgId])).rows.length) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "forbidden" });
    }
    const hash = canonicalPayloadHash({ command: "hardware_create", payload: b });
    if (b.client_operation_id) {
      const prior = await findSyncReceipt(client, orgId, b.client_operation_id);
      if (prior) {
        await client.query("ROLLBACK");
        if (prior.actor_user_id !== req.auth!.userId || prior.payload_hash !== hash) return res.status(409).json({ error: "idempotency_key_reused" });
        return res.status(201).json(prior.response_payload);
      }
    }
    const mountingScope = b.mounting_scope ?? "opening";
    const targetError = await validateMountingTarget(b.opening_id, mountingScope, b.door_leaf_id, b.frame_id, client);
    if (targetError) { await client.query("ROLLBACK"); return res.status(400).json({ error: targetError }); }
    const trackerId = generateTrackerId();
    const result = await client.query(
      `INSERT INTO hardware_components
        (id, opening_id, component_type, manufacturer, model_number, finish, install_date, warranty_expiration, notes,
         unit_cost, supplier_name, supplier_contact, tracker_id, serial_number, carrier, tracking_number,
         shipment_status, expected_delivery_date, shipped_date, delivered_date,
         mounting_scope, door_leaf_id, frame_id, position_label, client_operation_id,
         condition, identity_status, review_state, replacement_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING *`,
      [
        b.id ?? randomUUID(), b.opening_id, b.component_type, b.manufacturer ?? null, b.model_number ?? null,
        b.finish ?? null, b.install_date ?? null, b.warranty_expiration ?? null, b.notes ?? null,
        b.unit_cost ?? null, b.supplier_name ?? null, b.supplier_contact ?? null,
        trackerId, b.serial_number ?? null, b.carrier ?? null, b.tracking_number ?? null,
        b.shipment_status ?? "not_shipped", b.expected_delivery_date ?? null,
        b.shipped_date ?? null, b.delivered_date ?? null,
        mountingScope, b.door_leaf_id ?? null, b.frame_id ?? null,
        b.position_label ?? null, b.client_operation_id ?? null,
        b.condition ?? "unverified", b.identity_status ?? "unresolved",
        b.review_state ?? "pending", b.replacement_required ?? false,
      ]
    );
    if (b.client_operation_id) await hardwareReceipt(client, req, result.rows[0], b.client_operation_id, hash, "create", null, Object.keys(b));
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "entity_or_operation_already_exists" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
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
      "SELECT * FROM current_hardware_components WHERE opening_id = $1 ORDER BY install_date",
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
      `SELECT * FROM current_hardware_components WHERE ${conditions.join(" AND ")} ORDER BY install_date LIMIT 1000`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const updateHardwareSchema = createHardwareSchema.partial().omit({ id: true, opening_id: true }).extend({ expected_revision: z.number().int().positive().nullable().optional() });

hardwareRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const parsed = updateHardwareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { expected_revision, client_operation_id, ...changes } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(
      `SELECT * FROM hardware_components WHERE id=$1 AND opening_id IN (${openingsForOrgSubquery(2)}) FOR UPDATE`,
      [req.params.id, req.auth!.organizationId])).rows[0];
    if (!current) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    const hash = canonicalPayloadHash({ command: "hardware_update", id: req.params.id, payload: parsed.data });
    if (client_operation_id) {
      const prior = await findSyncReceipt(client, req.auth!.organizationId, client_operation_id);
      if (prior) {
        await client.query("ROLLBACK");
        if (prior.actor_user_id !== req.auth!.userId || prior.payload_hash !== hash) return res.status(409).json({ error: "idempotency_key_reused" });
        return res.json(prior.response_payload);
      }
    }
    if(current.lifecycle_state==='retired'){await client.query("ROLLBACK");return res.status(409).json({error:'component_retired'});}
    if(current.position_id&&['mounting_scope','door_leaf_id','frame_id','component_type'].some(k=>(changes as any)[k]!==undefined&&(changes as any)[k]!==current[k])){await client.query("ROLLBACK");return res.status(409).json({error:'position_identity_immutable'});}
    const conflict = revisionConflict(current, expected_revision);
    if (conflict) { await client.query("ROLLBACK"); return res.status(409).json(conflict); }
    const merged = { ...current, ...changes };
    const targetError = await validateMountingTarget(current.opening_id, merged.mounting_scope, merged.door_leaf_id ?? undefined, merged.frame_id ?? undefined, client);
    if (targetError) { await client.query("ROLLBACK"); return res.status(400).json({ error: targetError }); }
    const fields = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (!fields.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "no_fields_to_update" }); }
    const values: any[] = fields.map(([, value]) => value);
    values.push(current.id);
    const result = await client.query(`UPDATE hardware_components SET ${fields.map(([key], i) => key + '=$' + (i + 1)).join(',')}, revision=revision+1 WHERE id=$${values.length} RETURNING *`, values);
    if (client_operation_id) await hardwareReceipt(client, req, result.rows[0], client_operation_id, hash, "update", expected_revision!, Object.keys(changes));
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "idempotency_key_reused" });
    console.error(err); return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});

async function hardwareReceipt(client: any, req: AuthedRequest, row: any, operationId: string, payloadHash: string, operationType: "create" | "update", baseServerRevision: number | null, changedFields: string[]) {
  return writeSyncReceiptAndAudit(client, { organizationId: req.auth!.organizationId, openingId: row.opening_id,
    operationId, operationType, entityType: "component", entityId: row.id, payloadHash, baseServerRevision,
    resultingServerRevision: Number(row.revision), actorUserId: req.auth!.userId, deviceId: req.auth!.userId,
    schemaVersion: 3, appVersion: "connected-command-1", protocolVersion: 1, responsePayload: row,
    action: "hardware_" + operationType, changedFields });
}

hardwareRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const openingId = await assertHardwareInOrg(id, orgId);
    if (!openingId) return res.status(404).json({ error: "not_found" });

    await pool.query("DELETE FROM hardware_components WHERE id = $1", [id]);
    res.status(204).send();
  } catch (err:any) {
    if(err.code==='23503')return res.status(409).json({error:'component_referenced_by_record'});
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
