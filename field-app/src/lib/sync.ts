import { claimSyncOperation, DB_REQUEST_TIMEOUT_MS, getAllSyncOperations, getOfflineMedia, getOfflineSetting, getSyncOperationsForPrincipal, loadAuth, putOfflineSetting, putSyncConflict, putSyncOperation, putSyncReceipt, reconcileRecoveredMediaOperationId, resetFieldAppDb, saveEntityAndOperation, withDbTimeout, OiDataWipedError } from "./db";
import { isRequestTimeout, withTimeout } from "./deadline";
import { isDeviceStorageError, storageDiagnostic } from "./storageErrors";
import { confirmOfflinePhoto, recoverOfflinePhotoReservation, reserveOfflinePhoto, submitOfflineComponent, submitOfflineOperation, submitServiceRequest, uploadPrivatePhoto, ApiError, PrincipalChangedError, isClientPrincipalChange, isSessionEnded } from "./api";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "./offlineTypes";
import type { OfflineEntityEnvelope, OfflineEntityType, SyncConflict, SyncOperation, SyncOperationState, SyncReceipt } from "./offlineTypes";
import { readyOperations, retryDelayMs } from "./offlineSyncModel";
import { SITE_ACCESS_REQUIRED } from "./siteAccess";
import { MEDIA_TOO_LARGE, maximumMediaBytes } from "./mediaLimits";
import type { OutboxItem } from "./db";
import { assertSyncDispatchAllowed, SyncNavigationPaused } from './syncNavigation';

type SyncListener = (state: SyncState) => void;
export interface SyncState { pending: number; syncing: boolean; failed: number; conflicts: number; lastError?: string; checked?: boolean; checkFailed?: boolean; diagnostic?: string; userId?: string; organizationId?: string; }
const APP_VERSION = "offline-protocol-1";
let rememberedDeviceId: string | null = null;
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
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await withTimeout(value.arrayBuffer(), DB_REQUEST_TIMEOUT_MS, "digest timed out"));
  const digest = await withTimeout(crypto.subtle.digest("SHA-256", bytes), DB_REQUEST_TIMEOUT_MS, "digest timed out");
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}
export async function getOrCreateDeviceId(): Promise<string> {
  try {
    const existing = await getOfflineSetting("device_id");
    if (typeof existing?.value === "string") {
      rememberedDeviceId = existing.value;
      return existing.value;
    }
    const value = rememberedDeviceId ?? crypto.randomUUID();
    rememberedDeviceId = value;
    await putOfflineSetting({ key: "device_id", value, updatedAt: new Date().toISOString() });
    return value;
  } catch (error) {
    if (!isRequestTimeout(error)) throw error;
    if (!rememberedDeviceId) rememberedDeviceId = crypto.randomUUID();
    return rememberedDeviceId;
  }
}
let statusRead = 0;
let pendingCountRetry: ReturnType<typeof setTimeout> | null = null;
let pendingCountAttempt = 0;

export function noteSyncDiagnostic(error: unknown, force = false) {
  if (!force && !isDeviceStorageError(error)) return;
  currentState = { ...currentState, diagnostic: storageDiagnostic(error) };
  notify();
}

export function browserIsOnline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === true;
}

/** One local write, then one retry after the cached database connection is dropped. */
export async function runLocalWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    noteSyncDiagnostic(error, true);
    await resetFieldAppDb();
    try {
      return await write();
    } catch (retryError) {
      noteSyncDiagnostic(retryError, true);
      await resetFieldAppDb();
      throw retryError;
    }
  }
}

function schedulePendingCountRetry() {
  if (pendingCountRetry || typeof window === "undefined") return;
  const delay = Math.min(30_000, 500 * 2 ** pendingCountAttempt);
  pendingCountAttempt += 1;
  pendingCountRetry = setTimeout(() => {
    pendingCountRetry = null;
    void refreshPendingCount();
  }, delay);
}

export async function refreshPendingCount() {
  const read = ++statusRead;
  try {
  const auth = await loadAuth();
  const operations = auth ? await withDbTimeout(getSyncOperationsForPrincipal(auth.userId, auth.organizationId)) : [];
  const latest = await loadAuth();
  if (read !== statusRead) return;
  if (auth?.userId !== latest?.userId || auth?.organizationId !== latest?.organizationId) {
    currentState = { pending: 0, syncing: currentState.syncing, failed: 0, conflicts: 0, checked: false }; notify(); return;
  }
  pendingCountAttempt = 0;
  currentState = { ...currentState,
    checked: true, checkFailed: false, diagnostic: undefined, userId: auth?.userId, organizationId: auth?.organizationId,
    pending: operations.filter((item) => ["local_committed", "queued", "retry_wait", "blocked_dependency", "in_flight", "verifying"].includes(item.state)).length,
    failed: operations.filter((item) => ["permanent_failure", "auth_required", "storage_pressure", "schema_blocked"].includes(item.state)).length,
    conflicts: operations.filter((item) => item.state === "conflict").length };
  notify();
  } catch (error) {
    if (read !== statusRead) return;
    await resetFieldAppDb();
    noteSyncDiagnostic(error, true);
    currentState = { ...currentState, pending: 0, failed: 0, conflicts: 0, checked: false, checkFailed: true }; notify();
    schedulePendingCountRetry();
  }
}
function entityTypeForKind(kind: OutboxItem["kind"]): OfflineEntityType {
  if (kind === "service_request") return "service_request";
  if (kind === "opening_frame") return "frame";
  if (kind === "door_leaf") return "door_leaf";
  if (kind === "hardware_component") return "component";
  if (kind === "service_event") return "service_event";
  if (kind === "inspection_event") return "inspection_event";
  return "completion";
}
function markSent(error: unknown): unknown {
  if (error instanceof Error) (error as Error & { sentToServer?: boolean }).sentToServer = true;
  return error;
}

async function postInspectionOnline(operation: SyncOperation, auth: Principal, cause: unknown): Promise<string> {
  if (isRequestTimeout(cause)) await resetFieldAppDb().catch(() => undefined);
  try {
    await submitGeneralOperation(operation, auth);
  } catch (serverError) {
    noteSyncDiagnostic(serverError, true);
    throw serverError;
  }
  if (isRequestTimeout(cause)) throw markSent(cause);
  return operation.operationId;
}

export async function queueOpeningMutation(kind: OutboxItem["kind"], openingId: string, payload: any, id = crypto.randomUUID(), principal?: Principal) {
  const auth = await loadAuth(); if (!auth) throw new Error("auth_required");
  if(principal && (auth.userId!==principal.userId || auth.organizationId!==principal.organizationId))throw new PrincipalChangedError();
  const now = new Date().toISOString(); const entityType = entityTypeForKind(kind); const entityId = payload.id ?? id;
  const deviceId = await getOrCreateDeviceId(); const semanticPayload = { kind, ...payload };
  let existingOperations: SyncOperation[] = [];
  let readTimedOut = false;
  try {
    existingOperations = await withDbTimeout(getAllSyncOperations());
  } catch (error) {
    if (!(entityType === "inspection_event" && isRequestTimeout(error))) throw error;
    readTimedOut = true;
  }
  if(entityType==='service_request'){
    const existing=existingOperations.find(op=>op.operationId===id);
    if(existing){
      if(existing.actorUserId!==auth.userId || existing.organizationId!==auth.organizationId || existing.openingId!==openingId || JSON.stringify(canonicalize(existing.payload))!==JSON.stringify(canonicalize(semanticPayload)))throw new Error('request_retry_changed');
      return id;
    }
  }
  let baseServerRevision: number | null = null;
  if (entityType === "frame" || entityType === "door_leaf") {
    const owned = existingOperations.filter(op => op.entityId === entityId && op.actorUserId === auth.userId && op.organizationId === auth.organizationId);
    const pending = owned.find(op => op.state !== "verified");
    if (pending) {
      const deviceForPending = await getOrCreateDeviceId();
      const nowPending = new Date().toISOString();
      const nextPayload = { ...pending.payload as Record<string, unknown>, ...payload, kind, id: entityId, expected_revision: pending.baseServerRevision };
      const nextHash = await sha256Hex(JSON.stringify(canonicalize(nextPayload)));
      const operation: SyncOperation = { ...pending, payload: nextPayload, payloadHash: nextHash, state: "queued",
        nextAttemptAt: undefined, lastErrorCode: undefined, dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined };
      const entity: OfflineEntityEnvelope = { key: entityKey(entityType, entityId), id: entityId, entityType,
        organizationId: auth.organizationId, openingId, createdByUserId: auth.userId, createdByDeviceId: deviceForPending,
        createdAtLocal: pending.createdAtLocal, updatedAtLocal: nowPending, serverRevision: null, baseSnapshotHash: null,
        schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: APP_VERSION, syncState: "queued", retryCount: 0, payload: nextPayload };
      await runLocalWrite(() => withDbTimeout(saveEntityAndOperation(entity, operation)));
      try { await refreshPendingCount(); } catch (error) { if (!isRequestTimeout(error)) throw error; }
      void flushOutbox();
      return pending.operationId;
    }
    baseServerRevision = payload.expected_revision ?? null;
  }
  const dependencyOperationIds = dependencyIdsForOperation(existingOperations, entityType, openingId, payload);
  let payloadHash = "unhashed";
  try {
    payloadHash = await sha256Hex(JSON.stringify(canonicalize(semanticPayload)));
  } catch (error) {
    if (!(entityType === "inspection_event" && isRequestTimeout(error) && browserIsOnline())) throw error;
    readTimedOut = true;
  }
  const operation: SyncOperation = { operationId: id, operationType: kind === "complete_opening" ? "complete" : baseServerRevision !== null ? "update" : "create",
    entityType, entityId, openingId, organizationId: auth.organizationId, actorUserId: auth.userId, deviceId,
    baseServerRevision, payload: semanticPayload, payloadHash,
    dependencyOperationIds, createdAtLocal: now, state: dependencyOperationIds.length ? "blocked_dependency" : "queued", attemptCount: 0,
    schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: APP_VERSION, protocolVersion: SYNC_PROTOCOL_VERSION };
  if (readTimedOut && entityType === "inspection_event" && browserIsOnline()) {
    return postInspectionOnline(operation, auth, new DOMException("IndexedDB request timed out", "TimeoutError"));
  }
  const entity: OfflineEntityEnvelope = { key: entityKey(entityType, entityId), id: entityId, entityType,
    organizationId: auth.organizationId, openingId, parentEntityId: payload.door_leaf_id ?? payload.frame_id,
    createdByUserId: auth.userId, createdByDeviceId: deviceId, createdAtLocal: now, updatedAtLocal: now,
    serverRevision: null, baseSnapshotHash: null, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: APP_VERSION,
    syncState: "queued", retryCount: 0, payload: semanticPayload };
  await assertPrincipal(auth);
  try {
    await runLocalWrite(() => withDbTimeout(saveEntityAndOperation(entity, operation)));
  } catch (error) {
    if (entityType === "inspection_event" && browserIsOnline()) return postInspectionOnline(operation, auth, error);
    throw error;
  }
  try { await refreshPendingCount(); } catch (error) { if (!isRequestTimeout(error)) throw error; }
  void flushOutbox(); return id;
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
  } else if (entityType === "inspection_event") {
    const items = payload.checklist_result?.items;
    if (items && typeof items === "object") {
      for (const item of Object.values(items as Record<string, unknown>)) {
        const photoId = item && typeof item === "object" ? (item as { photo_id?: unknown }).photo_id : undefined;
        if (typeof photoId !== "string" || !photoId) continue;
        for (const parent of operations) {
          if (parent.openingId === openingId && parent.entityType === "photo" && parent.entityId === photoId && parent.state !== "verified") {
            ids.add(parent.operationId);
          }
        }
      }
    }
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
    throw new PrincipalChangedError();
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
  // Media queued by an earlier app version may exceed the server limit; stop
  // before any request so it is surfaced for review instead of retried.
  if (media.byteSize > maximumMediaBytes(media.contentType)) throw new Error(MEDIA_TOO_LARGE);
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
    assertSyncDispatchAllowed();
    await uploadPrivatePhoto(reservation.upload_url, media.blob, media.contentType, media.sha256Checksum, media.photoId);
  }
  await assertPrincipal(principal);
  return confirmOfflinePhoto({ photo_id: media.photoId, client_operation_id: operation.operationId,
    schema_version: operation.schemaVersion, app_version: operation.appVersion, protocol_version: operation.protocolVersion }, principal);
}
async function submitGeneralOperation(operation: SyncOperation, principal: Principal) {
  const { kind: _kind, id: _id, opening_id: _opening, client_operation_id: _client, expected_revision: _revision, ...payload } = operation.payload as any;
  if(operation.entityType==='service_request')return submitServiceRequest({operation_id:operation.operationId,entity_id:operation.entityId,opening_id:operation.openingId,
    device_id:operation.deviceId,schema_version:operation.schemaVersion,app_version:operation.appVersion,protocol_version:operation.protocolVersion,payload},principal);
  return submitOfflineOperation({
    operation_id: operation.operationId, operation_type: operation.operationType,
    entity_id: operation.entityId, entity_type: operation.entityType,
    opening_id: operation.openingId, device_id: operation.deviceId,
    base_server_revision: operation.baseServerRevision, schema_version: operation.schemaVersion,
    app_version: operation.appVersion, protocol_version: operation.protocolVersion, payload,
  }, principal);
}
// A size refusal is final for these bytes: retrying cannot succeed, so the
// operation stops and is surfaced for review with the photograph retained.
export function isMediaSizeRejection(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 413 || error.message === MEDIA_TOO_LARGE;
  return error instanceof Error && (error.message === "upload_failed_413" || error.message === MEDIA_TOO_LARGE);
}
async function recordFailure(operation: SyncOperation, error: unknown) {
  // C2: access ended and the device was wiped; never write the operation back.
  if (isSessionEnded(error) || error instanceof OiDataWipedError) return;
  const tooLarge = isMediaSizeRejection(error);
  const finishedVisit = error instanceof ApiError && error.message === "visit_finished";
  const conflict = !tooLarge && !finishedVisit && error instanceof ApiError && error.status === 409;
  // A change of signed-in account (raised by this app) stops the operation like an authorization
  // failure, but is marked so that it resumes once the same account signs in again. A server 401/403
  // is not marked and stays stopped for review.
  const principalChange = isClientPrincipalChange(error);
  const siteAccess = error instanceof ApiError && error.message === SITE_ACCESS_REQUIRED;
  const authRequired = principalChange || (!siteAccess && error instanceof ApiError && (error.status === 401 || error.status === 403));
  const rejected = error instanceof ApiError && (error.status === 400 || error.status === 413 || error.status === 422);
  const state: SyncOperationState = tooLarge || rejected || finishedVisit ? "permanent_failure" : conflict ? "conflict" : authRequired ? "auth_required" : "retry_wait";
  const message = tooLarge ? MEDIA_TOO_LARGE : error instanceof Error ? error.message : "unknown_error";
  if (conflict) {
    const item: SyncConflict = { conflictId: crypto.randomUUID(), operationId: operation.operationId,
      entityId: operation.entityId, openingId: operation.openingId, organizationId: operation.organizationId,
      affectedFields: [], baseValues: {}, localValues: operation.payload as Record<string, unknown>, serverValues: {},
      detectedAt: new Date().toISOString(), resolutionState: "open" };
    await putSyncConflict(item, message);
  } else await putSyncOperation({ ...operation, state, attemptCount: operation.attemptCount + 1,
    lastAttemptAt: new Date().toISOString(), nextAttemptAt: authRequired || tooLarge || finishedVisit ? undefined : new Date(Date.now() + retryDelayMs(operation.attemptCount)).toISOString(),
    dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined, lastErrorCode: message, principalChangeStop: principalChange ? true : undefined });
  currentState = { ...currentState, lastError: message };
  notify();
}

export async function awaitInspectionSynced(entityId: string): Promise<{ ok: true } | { ok: false; waiting: boolean; reason: string }> {
  const syncing = "Syncing… email will be available once synced";
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, waiting: false, reason: "Emailing this report needs a connection." };
  }
  const idle = () => new Promise<void>((resolve) => {
    const stop = onSyncStateChange((state) => {
      if (!state.syncing) { stop(); resolve(); }
    });
  });
  await idle();
  await flushOutbox();
  await idle();
  const auth = await loadAuth();
  if (!auth) return { ok: false, waiting: false, reason: "Sign in to sync this inspection." };
  const operations = await getSyncOperationsForPrincipal(auth.userId, auth.organizationId);
  const operation = operations.find((item) => item.entityId === entityId && item.entityType === "inspection_event");
  if (!operation || operation.state === "verified") return { ok: true };
  if (operation.state === "permanent_failure" || operation.state === "auth_required" || operation.state === "conflict" || operation.state === "schema_blocked") {
    return { ok: false, waiting: false, reason: `Sync failed: ${operation.lastErrorCode || operation.state}` };
  }
  if (operation.lastErrorCode) return { ok: false, waiting: true, reason: `Sync failed: ${operation.lastErrorCode}. It will try again.` };
  return { ok: false, waiting: true, reason: syncing };
}
type FlushRun = { stop: boolean };

export async function flushVersionedOperations(run: FlushRun = { stop: false }) {
  if (run.stop) return;
  try { assertSyncDispatchAllowed(); } catch { return; }
  if (run.stop) return;
  const auth = await withDbTimeout(loadAuth());
  if (run.stop || !auth) return;
  const principal = { userId: auth.userId, organizationId: auth.organizationId };
  while (!run.stop) {
    try { assertSyncDispatchAllowed(); } catch { return; }
    if (run.stop) return;
    try { await assertPrincipal(principal); }
    catch (error) {
      // The signed-in account changed since this pass started: stop this pass. The new account's
      // own pass handles its operations; this account's resume after it signs in again.
      if (isClientPrincipalChange(error) || run.stop) return;
      throw error;
    }
    if (run.stop) return;
    const operations = await withDbTimeout(getSyncOperationsForPrincipal(principal.userId, principal.organizationId));
    if (run.stop) return;
    const verified = new Set(operations.filter((item) => item.state === "verified").map((item) => item.operationId));
    const [candidate] = readyOperations(operations.filter((item) => item.state !== "verified"), verified, new Date().toISOString());
    if (!candidate) break;
    try { assertSyncDispatchAllowed(); } catch { return; }
    if (run.stop) return;
    const operation = await withDbTimeout(claimSyncOperation({ operationId: candidate.operationId, ...principal,
      leaseId: dispatchLeaseId, nowIso: new Date().toISOString(), leaseDurationMs: DISPATCH_LEASE_MS }));
    if (run.stop || !operation) continue;
    try {
      assertSyncDispatchAllowed();
      const row = operation.entityType === "photo" ? await submitPhoto(operation, principal)
        : operation.entityType === "component" ? await submitComponent(operation, principal)
          : await submitGeneralOperation(operation, principal);
      if (run.stop) return;
      await withDbTimeout(putSyncReceipt(receiptFromApi(row)));
    }
    catch (error) {
      if (run.stop) return;
      if (isRequestTimeout(error)) throw error;
      if (error instanceof SyncNavigationPaused) {
        // Preserve identity and bytes for idempotent reconciliation on a later
        // explicit workspace visit; an earlier request may already have succeeded.
        await putSyncOperation({ ...operation, state: 'queued', dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined });
        return;
      }
      if (await recoverSizeSync(operation, error)) continue;
      await recordFailure(operation, error);
      if (isMediaSizeRejection(error)) continue;
      if (isClientPrincipalChange(error)) return;
      if (error instanceof ApiError && error.message === SITE_ACCESS_REQUIRED) return;
      if (!(error instanceof ApiError) || error.status >= 500) return;
    }
  }
}
function sizeSync(operation: SyncOperation): boolean {
  return operation.entityType === "frame" || operation.entityType === "door_leaf";
}

async function recoverSizeSync(operation: SyncOperation, error: unknown): Promise<boolean> {
  if (!sizeSync(operation) || !(error instanceof ApiError) || error.status !== 409) return false;
  if (error.message === "revision_conflict" && typeof error.serverRevision === "number" && error.serverRevision !== operation.baseServerRevision) {
    const payload = { ...(operation.payload as Record<string, unknown>), expected_revision: error.serverRevision };
    await putSyncOperation({ ...operation, baseServerRevision: error.serverRevision, payload,
      payloadHash: await sha256Hex(JSON.stringify(canonicalize(payload))), state: "queued", nextAttemptAt: undefined,
      lastErrorCode: undefined, dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined });
    return true;
  }
  if (error.message === "idempotency_key_reused" && typeof error.serverRevision === "number") {
    await putSyncOperation({ ...operation, state: "verified", lastErrorCode: undefined, dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined });
    const now = new Date().toISOString();
    const payload = { ...(operation.payload as Record<string, unknown>), expected_revision: error.serverRevision };
    const next: SyncOperation = { ...operation, operationId: crypto.randomUUID(), baseServerRevision: error.serverRevision, payload,
      payloadHash: await sha256Hex(JSON.stringify(canonicalize(payload))), state: "queued", attemptCount: 0, createdAtLocal: now,
      lastErrorCode: undefined, nextAttemptAt: undefined, dependencyOperationIds: [], dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined };
    await saveEntityAndOperation({ key: entityKey(operation.entityType, operation.entityId), id: operation.entityId, entityType: operation.entityType,
      organizationId: operation.organizationId, openingId: operation.openingId, createdByUserId: operation.actorUserId,
      createdByDeviceId: operation.deviceId, createdAtLocal: now, updatedAtLocal: now, serverRevision: null, baseSnapshotHash: null,
      schemaVersion: operation.schemaVersion, appVersion: operation.appVersion, syncState: "queued", retryCount: 0, payload }, next);
    return true;
  }
  if (error.message === "leaf_role_configuration_mismatch" || error.message === "permanent_entity_identity_conflict") {
    await putSyncOperation({ ...operation, state: "permanent_failure", lastErrorCode: error.message, dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined });
    currentState = { ...currentState, lastError: error.message };
    notify();
    return true;
  }
  return false;
}

export const FLUSH_TIMEOUT_MS = 25_000;
let activeFlush: FlushRun | null = null;

export async function flushOutbox(timeoutMs = FLUSH_TIMEOUT_MS) {
  if (currentState.syncing || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  const run: FlushRun = { stop: false };
  activeFlush = run;
  currentState = { ...currentState, syncing: true }; notify();
  try { await withTimeout(flushVersionedOperations(run), timeoutMs, "sync timed out"); }
  catch (error) {
    run.stop = true;
    if (activeFlush !== run) return;
    noteSyncDiagnostic(error, true);
    currentState = { ...currentState, lastError: error instanceof Error ? error.message : "unknown_error" };
    if (isRequestTimeout(error)) await resetFieldAppDb().catch(() => undefined);
  }
  finally {
    if (activeFlush === run) {
      run.stop = true;
      activeFlush = null;
      currentState = { ...currentState, syncing: false }; notify();
      await refreshPendingCount().catch(() => undefined);
    }
  }
}
function flushOnSchedule() { void flushOutbox(); }

export function initSync() {
  void refreshPendingCount(); window.addEventListener("online", flushOnSchedule);
  const interval = setInterval(flushOnSchedule, 30_000); void flushOutbox();
  return () => { window.removeEventListener("online", flushOnSchedule); clearInterval(interval); };
}
export async function checksumBlob(blob: Blob) { return sha256Hex(blob); }
