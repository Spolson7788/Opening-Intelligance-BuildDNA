import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { openingsForOrgSubquery } from "../db/tenantScope";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { enforceRolePermissions } from "../middleware/permissions";
import {
  assertReceiptReplay,
  findSyncReceipt,
  writeSyncReceiptAndAudit,
} from "../services/syncProtocol";

export const syncRouter = Router();
syncRouter.use(requireAuth);
syncRouter.use(enforceRolePermissions);
syncRouter.use(auditLog);

const componentType = z.enum([
  "lockset", "cylinder", "closer", "exit_device", "hinge",
  "automatic_operator", "panic_bar", "access_control_reader",
  "keypad", "electric_strike", "power_transfer", "maglock",
  "request_to_exit_device", "other",
]);

const syncComponentCreate = z.object({
  operation_id: z.string().uuid(),
  entity_id: z.string().uuid(),
  opening_id: z.string().uuid(),
  device_id: z.string().uuid(),
  payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
  base_server_revision: z.null(),
  schema_version: z.number().int().positive(),
  app_version: z.string().min(1).max(100),
  protocol_version: z.number().int().positive(),
  payload: z.object({
    component_type: componentType,
    manufacturer: z.string().optional(),
    model_number: z.string().optional(),
    finish: z.string().optional(),
    notes: z.string().optional(),
    mounting_scope: z.enum(["opening", "frame", "door_leaf"]).default("opening"),
    door_leaf_id: z.string().uuid().optional(),
    frame_id: z.string().uuid().optional(),
    position_label: z.string().optional(),
    condition: z.enum(["good", "worn", "failed", "unverified"]).default("unverified"),
    identity_status: z.enum(["established", "unresolved"]).default("unresolved"),
    review_state: z.enum(["pending", "reviewed"]).default("pending"),
    replacement_required: z.boolean().default(false),
  }),
});

function trackerId() {
  return `TRK-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function validateComponentTarget(
  client: any,
  openingId: string,
  payload: z.infer<typeof syncComponentCreate>["payload"],
) {
  if (payload.mounting_scope === "opening") {
    return payload.door_leaf_id || payload.frame_id ? "opening_scope_cannot_have_leaf_or_frame" : null;
  }
  if (payload.mounting_scope === "frame") {
    if (!payload.frame_id || payload.door_leaf_id) return "frame_target_required";
    const frame = await client.query("SELECT 1 FROM opening_frames WHERE id=$1 AND opening_id=$2", [payload.frame_id, openingId]);
    return frame.rows.length ? null : "frame_not_in_opening";
  }
  if (!payload.door_leaf_id || payload.frame_id) return "door_leaf_target_required";
  const leaf = await client.query("SELECT 1 FROM door_leaves WHERE id=$1 AND opening_id=$2", [payload.door_leaf_id, openingId]);
  return leaf.rows.length ? null : "door_leaf_not_in_opening";
}

syncRouter.post("/components", async (req: AuthedRequest, res) => {
  const parsed = syncComponentCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const opening = await client.query(
      `SELECT id FROM openings WHERE id=$1 AND id IN (${openingsForOrgSubquery(2)}) FOR UPDATE`,
      [b.opening_id, orgId],
    );
    if (!opening.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "forbidden" });
    }

    const prior = await findSyncReceipt(client, orgId, b.operation_id);
    if (prior) {
      const replay = assertReceiptReplay(prior, { entityId: b.entity_id, payloadHash: b.payload_hash });
      await client.query("ROLLBACK");
      if (replay === "idempotency_key_reused") {
        return res.status(409).json({ error: replay });
      }
      return res.json({ ...prior, status: "already_applied" });
    }

    const targetError = await validateComponentTarget(client, b.opening_id, b.payload);
    if (targetError) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: targetError });
    }

    const component = await client.query(
      `INSERT INTO hardware_components
        (id, opening_id, component_type, manufacturer, model_number, finish, notes, tracker_id,
         mounting_scope, door_leaf_id, frame_id, position_label, client_operation_id,
         condition, identity_status, review_state, replacement_required, revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1)
       RETURNING *`,
      [b.entity_id, b.opening_id, b.payload.component_type, b.payload.manufacturer ?? null,
        b.payload.model_number ?? null, b.payload.finish ?? null, b.payload.notes ?? null,
        trackerId(), b.payload.mounting_scope, b.payload.door_leaf_id ?? null,
        b.payload.frame_id ?? null, b.payload.position_label ?? null, b.operation_id,
        b.payload.condition, b.payload.identity_status, b.payload.review_state,
        b.payload.replacement_required],
    );
    const changedFields = Object.keys(b.payload).sort();
    const receipt = await writeSyncReceiptAndAudit(client, {
      organizationId: orgId,
      openingId: b.opening_id,
      operationId: b.operation_id,
      operationType: "create",
      entityType: "component",
      entityId: b.entity_id,
      payloadHash: b.payload_hash,
      baseServerRevision: null,
      resultingServerRevision: 1,
      actorUserId: userId,
      deviceId: b.device_id,
      schemaVersion: b.schema_version,
      appVersion: b.app_version,
      protocolVersion: b.protocol_version,
      responsePayload: component.rows[0],
      action: "component_created_offline",
      changedFields,
    });
    await client.query("COMMIT");
    return res.status(201).json(receipt);
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "entity_or_operation_already_exists" });
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});
