import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

export function normalizedRecordHash(record: unknown): string {
  return canonicalPayloadHash(record);
}

export async function findSyncReceipt(
  client: PoolClient,
  organizationId: string,
  operationId: string,
) {
  const result = await client.query(
    `SELECT * FROM sync_operation_receipts WHERE organization_id=$1 AND operation_id=$2`,
    [organizationId, operationId],
  );
  return result.rows[0] ?? null;
}

export function assertReceiptReplay(
  receipt: any,
  expected: { entityId: string; payloadHash: string },
): "already_applied" | "idempotency_key_reused" {
  if (receipt.entity_id !== expected.entityId || receipt.payload_hash !== expected.payloadHash) {
    return "idempotency_key_reused";
  }
  return "already_applied";
}

export async function writeSyncReceiptAndAudit(client: PoolClient, input: {
  organizationId: string;
  openingId: string;
  operationId: string;
  operationType: "create" | "update" | "complete" | "upload_media" | "confirm_media" | "tombstone";
  entityType: "opening" | "frame" | "door_leaf" | "component" | "photo" | "service_event" | "inspection_event" | "completion" | "purchasing_review";
  entityId: string;
  payloadHash: string;
  baseServerRevision: number | null;
  resultingServerRevision: number;
  actorUserId: string;
  deviceId: string;
  schemaVersion: number;
  appVersion: string;
  protocolVersion: number;
  responsePayload: unknown;
  action: string;
  changedFields: string[];
}) {
  const recordHash = normalizedRecordHash(input.responsePayload);
  const receipt = await client.query(
    `INSERT INTO sync_operation_receipts
      (organization_id, opening_id, operation_id, operation_type, entity_type, entity_id,
       payload_hash, base_server_revision, resulting_server_revision, status,
       actor_user_id, device_id, schema_version, app_version, protocol_version,
       normalized_record_hash, response_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [input.organizationId, input.openingId, input.operationId, input.operationType,
      input.entityType, input.entityId, input.payloadHash, input.baseServerRevision,
      input.resultingServerRevision, input.actorUserId, input.deviceId,
      input.schemaVersion, input.appVersion, input.protocolVersion, recordHash,
      JSON.stringify(input.responsePayload)],
  );
  await client.query(
    `INSERT INTO sync_audit_events
      (organization_id, opening_id, operation_id, entity_type, entity_id, action,
       base_server_revision, resulting_server_revision, actor_user_id, device_id, changed_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.organizationId, input.openingId, input.operationId, input.entityType,
      input.entityId, input.action, input.baseServerRevision, input.resultingServerRevision,
      input.actorUserId, input.deviceId, input.changedFields],
  );
  return receipt.rows[0];
}
