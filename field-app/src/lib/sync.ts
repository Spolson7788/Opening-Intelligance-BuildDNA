import { claimSyncOperation, getAllSyncOperations, getOfflineMedia, getOfflineSetting, getSyncOperationsForPrincipal, loadAuth, putOfflineSetting, putSyncConflict, putSyncOperation, putSyncReceipt, reconcileRecoveredMediaOperationId, saveEntityAndOperation } from "./db";
import { confirmOfflinePhoto, recoverOfflinePhotoReservation, reserveOfflinePhoto, submitOfflineComponent, submitOfflineOperation, uploadPrivatePhoto, ApiError } from "./api";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "./offlineTypes";
import type { OfflineEntityEnvelope, OfflineEntityType, SyncConflict, SyncOperation, SyncOperationState, SyncReceipt } from "./offlineTypes";
import { readyOperations, retryDelayMs } from "./offlineSyncModel";
import type { OutboxItem } from "./db";

type SyncListener = (state: SyncState) => void;
export interface SyncState { pending: number; syncing: boolean; failed: number; conflicts: number; lastError?: string; }
const APP_VERSION = "offline-protocol-1";
const DISPATCH_LEASE_MS = 2 * 60_000;
const dispatchLeaseId = crypto.randomUUID();
let listeners: SyncListener[] = [];
let currentState: SyncState = { pending: 0, syncing: false, failed: 0, conflicts: 0 };
function notify() { listeners.forEach((listener) => listener(currentState)); }

export function onSyncStateChange(listener: SyncListener) {
  listeners.push(listener); listener(currentState);
  return () => { listeners = listeners.filter((candidate) => candidate !== listener); };
}

async function sha256Hex(value: string | Blob): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}
export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await getOfflineSetting("device_id");
  if (typeof existing?.value === "string") return existing.value;
  const value = crypto.randomUUID();
  await putOfflineSetting({ key: "device_id", value, updatedAt: new Date().toISOString() });
  return value;
}
async function refreshPendingCount() {
  const auth = await loadAuth();
  const operations = auth ? await getSyncOperationsForPrincipal(auth.userId, auth.organizationId) : [];
  currentState = { ...currentState,
    pending: operations.filter((item) => ["local_committed", "queued", "retry_wait", "blocked_dependency", "in_flight", "verifying"].includes(item.state)).length,
    failed: operations.filter((item) => ["permanent_failure", "auth_required", "storage_pressure", "schema_blocked"].includes(item.state)).length,
    conflicts: operations.filter((item) => item.state === "conflict").length };
  notify();
}
function entityTypeForKind(kind: OutboxItem["kind"]): OfflineEntityType {
  if (kind === "opening_frame") return "frame";
  if (kind === "door_leaf") return "door_leaf";
  if (kind === "hardware_component") return "component";
  if (kind === "service_event") return "service_event";
  if (kind === "inspection_event") return "inspection_event";
  return "completion";
}
export async function queueOpeningMutation(kind: OutboxItem["kind"], openingId: string, payload: any, id = crypto.randomUUID()) {
  const auth = await loadAuth(); if (!auth) throw new Error("auth_required");
  const now = new Date().toISOString(); const entityType = entityTypeForKind(kind); const entityId = payload.id ?? id;
  const deviceId = await getOrCreateDeviceId(); const semanticPayload = { kind, ...payload };
  const existingOperations = await getAllSyncOperations();
  const dependencyOperationIds = dependencyIdsForOperation(existingOperations, entityType, openingId, payload);
  const operation: SyncOperation = { operationId: id, operationType: kind === "complete_opening" ? "complete" : "create",
    entityType, entityId, openingId, organizationId: auth.organizationId, actorUserId: auth.userId, deviceId,
    baseServerRevision: null, payload: semanticPayload, payloadHash: await sha256Hex(JSON.stringify(canonicalize(semanticPayload))),
    dependencyOperationIds, createdAtLocal: now, state: dependencyOperationIds.length ? "blocked_dependency" : "queued", attemptCount: 0,
    schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: APP_VERSION, protocolVersion: SYNC_PROTOCOL_VERSION };
  const entity: OfflineEntityEnvelope = { key: entityKey(entityType, entityId), id: entityId, entityType,
    organizationId: auth.organizationId, openingId, parentEntityId: payload.door_leaf_id ?? payload.frame_id,
    createdByUserId: auth.userId, createdByDeviceId: deviceId, createdAtLocal: now, updatedAtLocal: now,
    serverRevision: null, baseSnapshotHash: null, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: APP_VERSION,
    syncState: "queued", retryCount: 0, payload: semanticPayload };
  await saveEntityAndOperation(entity, operation); await refreshPendingCount(); void flushOutbox(); return id;
}
export function dependencyIdsForOperation(
  operations: SyncOperation[], entityType: OfflineEntityType, openingId: string, payload: Record<string, any>,
): string[] {
  const ids = new Set<string>();
  const addEntityDependency = (entityId?: string) => {
    if (!entityId) return;
    for (const parent of operations) {
      if (parent.openingId === openingId && parent.entityId === entityId && parent.state !== "verified") {
        ids.add(parent.operationId);
      }
    }
  };
  if (entityType === "component") {
    addEntityDependency(payload.door_leaf_id);
    addEntityDependency(payload.frame_id);
  } else if (entityType === "photo") {
    if (payload.target_type !== "opening") addEntityDependency(payload.target_id);
  } else if (entityType === "completion") {
    for (const candidate of operations) {
      if (candidate.openingId === openingId && ["frame", "door_leaf", "component"].includes(candidate.entityType) && candidate.state !== "verified") {
        ids.add(candidate.operationId);
      }
    }
  }
  return [...ids];
}
function receiptFromApi(row: any): SyncReceipt {
  return { operationId: row.operation_id, entityId: row.entity_id, entityType: row.entity_type,
    openingId: row.opening_id, organizationId: row.organization_id, serverRevision: Number(row.resulting_server_revision),
    normalizedRecordHash: row.normalized_record_hash, serverAcceptedAt: row.server_accepted_at, verifiedAt: row.verified_at,
    mediaObjectVerified: row.media_object_verified === true, authorizedRetrievalVerified: row.authorized_retrieval_verified === true };
}
type Principal = { userId: string; organizationId: string };
async function assertPrincipal(principal: Principal) {
  const auth = await loadAuth();
  if (!auth || auth.userId !== principal.userId || auth.organizationId !== principal.organizationId) {
    throw new ApiError(401, "active_principal_changed");
  }
}
async function submitComponent(operation: SyncOperation, principal: Principal) {
  const { kind: _kind, id: _id, opening_id: _opening, client_operation_id: _client, ...component } = operation.payload as any;
  return submitOfflineComponent({ operation_id: operation.operationId, entity_id: operation.entityId,
    opening_id: operation.openingId, device_id: operation.deviceId, base_server_revision: operation.baseServerRevision,
    schema_version: operation.schemaVersion, app_version: operation.appVersion, protocol_version: operation.protocolVersion,
    payload: component }, principal);
}
async function submitPhoto(operation: SyncOperation, principal: Principal) {
  const media = await getOfflineMedia(operation.entityId); if (!media) throw new Error("offline_media_missing");
  if ((operation.payload as Record<string, unknown>).legacy_identity_recovery === true) {
    try {
      const recovered = await recoverOfflinePhotoReservation({ photo_id: media.photoId,
        opening_id: media.openingId, target_type: media.targetType, target_id: media.targetId,
        original_filename: media.originalFilename, content_type: media.contentType, byte_size: media.byteSize,
        sha256_checksum: media.sha256Checksum, device_id: media.capturedByDeviceId,
        latitude: media.latitude, longitude: media.longitude }, principal);
      const reconciled = await reconcileRecoveredMediaOperationId(operation.operationId, recovered.client_operation_id);
      if (!reconciled) throw new Error("recovered_operation_not_found");
      Object.assign(operation, reconciled);
    } catch (error) {
      // A 404 proves there is no existing reservation, so the deterministic
      // fallback ID may safely create the first one. All other responses stop
      // and preserve the retained original for review.
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  const reservation = await reserveOfflinePhoto({ photo_id: media.photoId, client_operation_id: operation.operationId,
    opening_id: media.openingId, target_type: media.targetType, target_id: media.targetId,
    original_filename: media.originalFilename, content_type: media.contentType, byte_size: media.byteSize,
    sha256_checksum: media.sha256Checksum, device_id: media.capturedByDeviceId,
    latitude: media.latitude, longitude: media.longitude }, principal);
  await assertPrincipal(principal);
  if (reservation.status !== "verified") {
    if (!reservation.upload_url) throw new Error("photo_upload_authority_missing");
    await uploadPrivatePhoto(reservation.upload_url, media.blob, media.contentType, media.sha256Checksum, media.photoId);
  }
  await assertPrincipal(principal);
  return confirmOfflinePhoto({ photo_id: media.photoId, client_operation_id: operation.operationId,
    schema_version: operation.schemaVersion, app_version: operation.appVersion, protocol_version: operation.protocolVersion }, principal);
}
async function submitGeneralOperation(operation: SyncOperation, principal: Principal) {
  const { kind: _kind, id: _id, opening_id: _opening, client_operation_id: _client, ...payload } = operation.payload as any;
  return submitOfflineOperation({
    operation_id: operation.operationId, operation_type: operation.operationType,
    entity_id: operation.entityId, entity_type: operation.entityType,
    opening_id: operation.openingId, device_id: operation.deviceId,
    base_server_revision: operation.baseServerRevision, schema_version: operation.schemaVersion,
    app_version: operation.appVersion, protocol_version: operation.protocolVersion, payload,
  }, principal);
}
async function recordFailure(operation: SyncOperation, error: unknown) {
  const conflict = error instanceof ApiError && error.status === 409;
  const authRequired = error instanceof ApiError && (error.status === 401 || error.status === 403);
  const state: SyncOperationState = conflict ? "conflict" : authRequired ? "auth_required" : "retry_wait";
  const message = error instanceof Error ? error.message : "unknown_error";
  if (conflict) {
    const item: SyncConflict = { conflictId: crypto.randomUUID(), operationId: operation.operationId,
      entityId: operation.entityId, openingId: operation.openingId, organizationId: operation.organizationId,
      affectedFields: [], baseValues: {}, localValues: operation.payload as Record<string, unknown>, serverValues: {},
      detectedAt: new Date().toISOString(), resolutionState: "open" };
    await putSyncConflict(item);
  } else await putSyncOperation({ ...operation, state, attemptCount: operation.attemptCount + 1,
    lastAttemptAt: new Date().toISOString(), nextAttemptAt: authRequired ? undefined : new Date(Date.now() + retryDelayMs(operation.attemptCount)).toISOString(),
    dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined, lastErrorCode: message });
  currentState = { ...currentState, lastError: message };
}
export async function flushVersionedOperations() {
  const auth = await loadAuth();
  if (!auth) return;
  const principal = { userId: auth.userId, organizationId: auth.organizationId };
  while (true) {
    await assertPrincipal(principal);
    const operations = await getSyncOperationsForPrincipal(principal.userId, principal.organizationId);
    const verified = new Set(operations.filter((item) => item.state === "verified").map((item) => item.operationId));
    const [candidate] = readyOperations(operations.filter((item) => item.state !== "verified"), verified, new Date().toISOString());
    if (!candidate) break;
    const operation = await claimSyncOperation({ operationId: candidate.operationId, ...principal,
      leaseId: dispatchLeaseId, nowIso: new Date().toISOString(), leaseDurationMs: DISPATCH_LEASE_MS });
    if (!operation) continue;
    try {
      const row = operation.entityType === "photo" ? await submitPhoto(operation, principal)
        : operation.entityType === "component" ? await submitComponent(operation, principal)
          : await submitGeneralOperation(operation, principal);
      await putSyncReceipt(receiptFromApi(row));
    }
    catch (error) {
      await recordFailure(operation, error);
      if (!(error instanceof ApiError) || error.status >= 500) return;
    }
  }
}
export async function flushOutbox() {
  if (currentState.syncing || !navigator.onLine) return;
  currentState = { ...currentState, syncing: true }; notify();
  try { await flushVersionedOperations(); }
  finally { currentState = { ...currentState, syncing: false }; await refreshPendingCount(); }
}
export function initSync() {
  void refreshPendingCount(); window.addEventListener("online", flushOutbox);
  const interval = setInterval(flushOutbox, 30_000); void flushOutbox();
  return () => { window.removeEventListener("online", flushOutbox); clearInterval(interval); };
}
export async function checksumBlob(blob: Blob) { return sha256Hex(blob); }
