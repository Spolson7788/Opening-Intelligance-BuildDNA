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
  canonicalPayloadHash,
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
  payload_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
  const payloadHash = canonicalPayloadHash({
    operation_type: "create",
    entity_type: "component",
    entity_id: b.entity_id,
    opening_id: b.opening_id,
    base_server_revision: b.base_server_revision,
    payload: b.payload,
  });
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
      const replay = assertReceiptReplay(prior, { entityId: b.entity_id, payloadHash });
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
      payloadHash,
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

const generalSyncOperation = z.object({
  operation_id: z.string().uuid(),
  operation_type: z.enum(["create", "complete"]),
  entity_id: z.string().uuid(),
  entity_type: z.enum(["frame", "door_leaf", "service_event", "inspection_event", "completion"]),
  opening_id: z.string().uuid(),
  device_id: z.string().uuid(),
  base_server_revision: z.null(),
  schema_version: z.number().int().positive(),
  app_version: z.string().min(1).max(100),
  protocol_version: z.number().int().positive(),
  payload: z.record(z.unknown()),
});

const framePayload = z.object({
  material: z.string().optional(), frame_type: z.string().optional(), width_in: z.number().positive().optional(),
  height_in: z.number().positive().optional(), fire_rated: z.boolean().optional(),
  condition: z.enum(["good", "worn", "failed", "unverified"]).optional(), notes: z.string().optional(),
});
const leafPayload = z.object({
  leaf_role: z.enum(["single", "active", "inactive"]), handing: z.string().optional(), material: z.string().optional(),
  width_in: z.number().positive().optional(), height_in: z.number().positive().optional(), thickness_in: z.number().positive().optional(),
  fire_rated: z.boolean().optional(), condition: z.enum(["good", "worn", "failed", "unverified"]).optional(), notes: z.string().optional(),
});
const servicePayload = z.object({
  hardware_component_id: z.string().uuid().optional(), performed_by_org_id: z.string().uuid().optional(),
  event_date: z.string(), work_performed: z.string().min(1), parts_used: z.array(z.string()).optional(), cost: z.number().optional(),
});
const inspectionPayload = z.object({
  event_date: z.string(), inspection_type: z.enum(["general", "fire_door_nfpa80", "ada_compliance", "access_control"]),
  checklist_result: z.record(z.unknown()).optional(), passed: z.boolean(), notes: z.string().optional(),
  signature_data: z.string().max(500_000).optional(), signed_by_name: z.string().optional(),
});

syncRouter.post("/operations", async (req: AuthedRequest, res) => {
  const parsed = generalSyncOperation.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  if ((b.entity_type === "completion") !== (b.operation_type === "complete")) {
    return res.status(400).json({ error: "operation_entity_mismatch" });
  }
  const schema = b.entity_type === "frame" ? framePayload : b.entity_type === "door_leaf" ? leafPayload
    : b.entity_type === "service_event" ? servicePayload : b.entity_type === "inspection_event" ? inspectionPayload : z.object({});
  const payloadResult = schema.safeParse(b.payload);
  if (!payloadResult.success) return res.status(400).json({ error: payloadResult.error.flatten() });
  const payload: any = payloadResult.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;
  const payloadHash = canonicalPayloadHash({ operation_type: b.operation_type, entity_type: b.entity_type,
    entity_id: b.entity_id, opening_id: b.opening_id, base_server_revision: null, payload });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const openingResult = await client.query(
      `SELECT * FROM openings WHERE id=$1 AND id IN (${openingsForOrgSubquery(2)}) FOR UPDATE`, [b.opening_id, orgId],
    );
    const opening = openingResult.rows[0];
    if (!opening) { await client.query("ROLLBACK"); return res.status(403).json({ error: "forbidden" }); }
    const prior = await findSyncReceipt(client, orgId, b.operation_id);
    if (prior) {
      const replay = assertReceiptReplay(prior, { entityId: b.entity_id, payloadHash });
      await client.query("ROLLBACK");
      return replay === "idempotency_key_reused" ? res.status(409).json({ error: replay }) : res.json({ ...prior, status: "already_applied" });
    }
    let record: any;
    if (b.entity_type === "frame") {
      const permanent = await client.query("SELECT id FROM opening_frames WHERE opening_id=$1", [b.opening_id]);
      if (permanent.rows[0] && permanent.rows[0].id !== b.entity_id) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "permanent_entity_identity_conflict", entity_id: permanent.rows[0].id });
      }
      const result = await client.query(`INSERT INTO opening_frames
        (id,opening_id,material,frame_type,width_in,height_in,fire_rated,condition,notes,client_operation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (opening_id) DO UPDATE SET material=EXCLUDED.material,frame_type=EXCLUDED.frame_type,
        width_in=EXCLUDED.width_in,height_in=EXCLUDED.height_in,fire_rated=EXCLUDED.fire_rated,
        condition=EXCLUDED.condition,notes=EXCLUDED.notes,client_operation_id=EXCLUDED.client_operation_id,
        revision=opening_frames.revision+1,updated_at=now() RETURNING *`,
      [b.entity_id,b.opening_id,payload.material??null,payload.frame_type??null,payload.width_in??null,payload.height_in??null,
        payload.fire_rated??false,payload.condition??"unverified",payload.notes??null,b.operation_id]); record=result.rows[0];
    } else if (b.entity_type === "door_leaf") {
      if ((opening.opening_configuration === "single") !== (payload.leaf_role === "single")) {
        await client.query("ROLLBACK"); return res.status(409).json({ error: "leaf_role_configuration_mismatch" });
      }
      const permanent = await client.query(
        "SELECT id FROM door_leaves WHERE opening_id=$1 AND leaf_role=$2", [b.opening_id, payload.leaf_role],
      );
      if (permanent.rows[0] && permanent.rows[0].id !== b.entity_id) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "permanent_entity_identity_conflict", entity_id: permanent.rows[0].id });
      }
      const result=await client.query(`INSERT INTO door_leaves
        (id,opening_id,leaf_role,handing,material,width_in,height_in,thickness_in,fire_rated,condition,notes,client_operation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (opening_id,leaf_role) DO UPDATE SET handing=EXCLUDED.handing,material=EXCLUDED.material,
        width_in=EXCLUDED.width_in,height_in=EXCLUDED.height_in,thickness_in=EXCLUDED.thickness_in,
        fire_rated=EXCLUDED.fire_rated,condition=EXCLUDED.condition,notes=EXCLUDED.notes,
        client_operation_id=EXCLUDED.client_operation_id,revision=door_leaves.revision+1,updated_at=now() RETURNING *`,
      [b.entity_id,b.opening_id,payload.leaf_role,payload.handing??null,payload.material??null,payload.width_in??null,
        payload.height_in??null,payload.thickness_in??null,payload.fire_rated??false,payload.condition??"unverified",payload.notes??null,b.operation_id]); record=result.rows[0];
    } else if (b.entity_type === "service_event") {
      if (payload.performed_by_org_id && payload.performed_by_org_id !== orgId) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error:"service_provider_organization_forbidden" });
      }
      if (payload.hardware_component_id) {
        const target=await client.query("SELECT 1 FROM hardware_components WHERE id=$1 AND opening_id=$2",[payload.hardware_component_id,b.opening_id]);
        if (!target.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ error:"component_not_in_opening" }); }
      }
      const result=await client.query(`INSERT INTO service_events
        (id,opening_id,hardware_component_id,performed_by_org_id,performed_by_user_id,event_date,work_performed,parts_used,cost,client_operation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.entity_id,b.opening_id,payload.hardware_component_id??null,orgId,userId,payload.event_date,
        payload.work_performed,payload.parts_used??[],payload.cost??null,b.operation_id]); record=result.rows[0];
      await client.query(`UPDATE openings SET last_service_date=GREATEST(COALESCE(last_service_date,$1),$1) WHERE id=$2`,[payload.event_date,b.opening_id]);
    } else if (b.entity_type === "inspection_event") {
      const result=await client.query(`INSERT INTO inspection_events
        (id,opening_id,performed_by_user_id,event_date,inspection_type,checklist_result,passed,notes,signature_data,signed_by_name,signed_at,client_operation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.entity_id,b.opening_id,userId,payload.event_date,payload.inspection_type,payload.checklist_result??{},payload.passed,
        payload.notes??null,payload.signature_data??null,payload.signed_by_name??null,payload.signature_data?new Date().toISOString():null,b.operation_id]); record=result.rows[0];
    } else {
      const [frame,leaves,hardware]=await Promise.all([
        client.query("SELECT 1 FROM opening_frames WHERE opening_id=$1",[b.opening_id]),
        client.query("SELECT leaf_role FROM door_leaves WHERE opening_id=$1",[b.opening_id]),
        client.query("SELECT review_state FROM hardware_components WHERE opening_id=$1",[b.opening_id]),
      ]);
      const roles=new Set(leaves.rows.map((row:any)=>row.leaf_role));
      const leavesComplete=opening.opening_configuration === "pair" ? roles.has("active")&&roles.has("inactive") : roles.has("single");
      const missing=[...(frame.rows.length?[]:["frame"]),...(leavesComplete?[]:["door_leaf"]),
        ...(hardware.rows.length?[]:["hardware_component"]),...(hardware.rows.some((row:any)=>row.review_state!=="reviewed")?["hardware_review"]:[])];
      if (missing.length) { await client.query("ROLLBACK"); return res.status(409).json({ error:"opening_incomplete",missing }); }
      const result=await client.query(`UPDATE openings SET completion_state='complete',completed_at=COALESCE(completed_at,now()),
        completed_by_user_id=COALESCE(completed_by_user_id,$2),status='active',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [b.opening_id,userId]); record=result.rows[0];
    }
    const receipt=await writeSyncReceiptAndAudit(client,{ organizationId:orgId,openingId:b.opening_id,operationId:b.operation_id,
      operationType:b.operation_type,entityType:b.entity_type,entityId:b.entity_id,payloadHash,baseServerRevision:null,
      resultingServerRevision:Number(record.revision??1),actorUserId:userId,deviceId:b.device_id,schemaVersion:b.schema_version,
      appVersion:b.app_version,protocolVersion:b.protocol_version,responsePayload:record,
      action:`${b.entity_type}_${b.operation_type}_offline`,changedFields:Object.keys(payload).sort() });
    await client.query("COMMIT"); return res.status(201).json(receipt);
  } catch (err:any) {
    await client.query("ROLLBACK").catch(()=>undefined);
    if (err.code === "23505") return res.status(409).json({ error:"entity_or_operation_already_exists" });
    console.error(err); return res.status(500).json({ error:"internal_error" });
  } finally { client.release(); }
});
