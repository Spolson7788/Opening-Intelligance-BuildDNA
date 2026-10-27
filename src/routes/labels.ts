import { acquireClient } from '../db/acquireClient';
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { openingLabel, LABEL_TEMPLATE } from "../services/openingLabels";
import { openingQrUrl } from '../services/openingQr';
import { canonicalPayloadHash, findSyncReceipt, writeSyncReceiptAndAudit } from "../services/syncProtocol";

export const labelsRouter = Router();
labelsRouter.use(requireAuth, enforceRolePermissions);
labelsRouter.get('/config',(_req,res)=>{
  try{return res.json({field_base:openingQrUrl('').replace(/opening\/by-qr\/$/,'')});}
  catch{return res.status(503).json({error:'label_configuration_unavailable'});}
});
const ids = z.array(z.string().uuid()).min(1).max(100).refine(values => new Set(values).size === values.length);
const command = z.object({ opening_ids: ids, operation_id: z.string().uuid(), template: z.enum([LABEL_TEMPLATE, "single-2in-v1"]) })
  .refine(value => value.template !== "single-2in-v1" || value.opening_ids.length === 1);

labelsRouter.get("/preview", async (req: AuthedRequest, res) => {
  const parsed = ids.safeParse(typeof req.query.opening_ids === "string" ? req.query.opening_ids.split(",") : []);
  if (!parsed.success) return res.status(400).json({ error: "invalid_openings" });
  const client = await acquireClient(res); if (!client) return;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const items = [];
    for (const id of parsed.data) {
      const label = await openingLabel(client, id, req.auth!.organizationId);
      if (!label) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      items.push(label);
    }
    await client.query("COMMIT"); return res.json({ items, template: LABEL_TEMPLATE });
  } catch (err) { await client.query("ROLLBACK"); console.error(err); return res.status(500).json({ error: "label_unavailable" }); }
  finally { client.release(); }
});

labelsRouter.post("/generations", async (req: AuthedRequest, res) => {
  const parsed = command.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_label_request" });
  const b = parsed.data, org = req.auth!.organizationId, actor = req.auth!.userId;
  const hash = canonicalPayloadHash({ command: "label_generation", ...b });
  const client = await acquireClient(res); if (!client) return;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const items = [];
    for (const id of [...b.opening_ids].sort()) {
      const label = await openingLabel(client, id, org);
      if (!label) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      items.push(label);
    }
    if (items.some(item => !item.eligible)) { await client.query("ROLLBACK"); return res.status(409).json({ error: "label_not_ready", items }); }
    // Authorization is rechecked before replay; a revoked account cannot retrieve a prior file.
    const prior = await findSyncReceipt(client, org, b.operation_id);
    if (prior) {
      await client.query("ROLLBACK");
      if (prior.actor_user_id !== actor || prior.payload_hash !== hash) return res.status(409).json({ error: "idempotency_key_reused" });
      return res.json(prior.response_payload);
    }
    const result = { status: "print_file_generated", operation_id: b.operation_id, template: b.template, count: items.length,
      generated_at: new Date().toISOString(), items };
    await writeSyncReceiptAndAudit(client, { organizationId: org, openingId: items[0].id, operationId: b.operation_id,
      operationType: "create", entityType: "opening", entityId: items[0].id, payloadHash: hash, baseServerRevision: null,
      resultingServerRevision: items[0].revision, actorUserId: actor, deviceId: actor, schemaVersion: 3,
      appVersion: "labels-1", protocolVersion: 1, responsePayload: result, action: "label_print_file_generated", changedFields: [] });
    await client.query("COMMIT"); return res.status(201).json(result);
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (["23505", "40001"].includes(err.code)) return res.status(409).json({ error: "retry_same_label_request" });
    console.error(err); return res.status(500).json({ error: "label_unavailable" });
  } finally { client.release(); }
});
