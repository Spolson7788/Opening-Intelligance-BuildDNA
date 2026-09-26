import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "./offlineTypes";
import type {
  OfflineEntityEnvelope,
  OfflineMediaRecord,
  OfflineSetting,
  OpeningSnapshot,
  SyncConflict,
  SyncOperation,
  SyncReceipt,
} from "./offlineTypes";
import { interruptedOperationIsRecoverable } from "./offlineSyncModel";

interface FieldAppDB extends DBSchema {
  // Local cache of the last-seen version of each opening, so a technician can
  // still view opening details when there's no signal (e.g. a basement).
  openings: {
    key: string;
    value: any;
  };
  // Outbox: mutations captured while offline (or just to avoid blocking the UI
  // on a slow connection), flushed in order once connectivity returns.
  outbox: {
    key: string;
    value: OutboxItem;
  };
  // Photo outbox: unlike JSON events, this holds the actual image blob, since
  // a presigned upload URL can't be requested until we're back online anyway.
  // The blob is captured to disk immediately on shutter tap so nothing is lost
  // if the app closes before connectivity returns.
  photoOutbox: {
    key: string;
    value: PhotoOutboxItem;
  };
  auth: {
    key: string;
    value: { token: string; userId: string; organizationId: string; role: string; savedAt: number };
  };
  entities: {
    key: string;
    value: OfflineEntityEnvelope;
    indexes: { "by-opening": string; "by-sync-state": string; "by-organization": string };
  };
  operations: {
    key: string;
    value: SyncOperation;
    indexes: { "by-opening": string; "by-state": string; "by-next-attempt": string };
  };
  media: {
    key: string;
    value: OfflineMediaRecord;
    indexes: { "by-opening": string; "by-upload-state": string; "by-target": [string, string] };
  };
  syncReceipts: {
    key: string;
    value: SyncReceipt;
    indexes: { "by-opening": string; "by-entity": string };
  };
  conflicts: {
    key: string;
    value: SyncConflict;
    indexes: { "by-opening": string; "by-resolution-state": string };
  };
  openingSnapshots: {
    key: string;
    value: OpeningSnapshot;
    indexes: { "by-organization": string };
  };
  settings: {
    key: string;
    value: OfflineSetting;
  };
}

export interface OutboxItem {
  id: string; // uuid, generated client-side
  kind: "service_event" | "inspection_event" | "opening_frame" | "door_leaf" | "hardware_component" | "complete_opening";
  payload: any;
  openingId?: string;
  createdAt: number;
  attempts: number;
  status: "pending" | "failed" | "conflict";
  lastError?: string;
}

export interface PhotoOutboxItem {
  id: string;
  openingId: string;
  blob: Blob;
  contentType: string;
  relatedEntityType: "opening" | "frame" | "door_leaf" | "hardware_component";
  relatedEntityId?: string;
  frameId?: string;
  doorLeafId?: string;
  hardwareComponentId?: string;
  latitude?: number;
  longitude?: number;
  createdAt: number;
  attempts: number;
  status: "pending" | "failed" | "conflict";
  lastError?: string;
}

let dbPromise: Promise<IDBPDatabase<FieldAppDB>> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<FieldAppDB>("opening-intel-field", OFFLINE_SCHEMA_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("openings", { keyPath: "id" });
          db.createObjectStore("outbox", { keyPath: "id" });
          db.createObjectStore("auth");
        }
        if (oldVersion < 2) {
          db.createObjectStore("photoOutbox", { keyPath: "id" });
        }
        if (oldVersion < 3) {
          const entities = db.createObjectStore("entities", { keyPath: "key" });
          entities.createIndex("by-opening", "openingId");
          entities.createIndex("by-sync-state", "syncState");
          entities.createIndex("by-organization", "organizationId");

          const operations = db.createObjectStore("operations", { keyPath: "operationId" });
          operations.createIndex("by-opening", "openingId");
          operations.createIndex("by-state", "state");
          operations.createIndex("by-next-attempt", "nextAttemptAt");

          const media = db.createObjectStore("media", { keyPath: "photoId" });
          media.createIndex("by-opening", "openingId");
          media.createIndex("by-upload-state", "uploadState");
          media.createIndex("by-target", ["targetType", "targetId"]);

          const receipts = db.createObjectStore("syncReceipts", { keyPath: "operationId" });
          receipts.createIndex("by-opening", "openingId");
          receipts.createIndex("by-entity", "entityId");

          const conflicts = db.createObjectStore("conflicts", { keyPath: "conflictId" });
          conflicts.createIndex("by-opening", "openingId");
          conflicts.createIndex("by-resolution-state", "resolutionState");

          const snapshots = db.createObjectStore("openingSnapshots", { keyPath: "openingId" });
          snapshots.createIndex("by-organization", "organizationId");
          db.createObjectStore("settings", { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

export async function closeFieldAppDb() {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

export async function saveEntityAndOperation(
  entity: OfflineEntityEnvelope,
  operation: SyncOperation,
) {
  if (entity.id !== operation.entityId || entity.openingId !== operation.openingId) {
    throw new Error("entity_operation_identity_mismatch");
  }
  if (entity.organizationId !== operation.organizationId) {
    throw new Error("entity_operation_tenant_mismatch");
  }
  const db = await getDb();
  const tx = db.transaction(["entities", "operations"], "readwrite");
  await Promise.all([
    tx.objectStore("entities").put(entity),
    tx.objectStore("operations").put(operation),
    tx.done,
  ]);
}

export async function saveMediaAndOperation(media: OfflineMediaRecord, operation: SyncOperation) {
  if (media.photoId !== operation.entityId || media.openingId !== operation.openingId) {
    throw new Error("media_operation_identity_mismatch");
  }
  if (media.organizationId !== operation.organizationId) {
    throw new Error("media_operation_tenant_mismatch");
  }
  const db = await getDb();
  const tx = db.transaction(["media", "operations"], "readwrite");
  await Promise.all([
    tx.objectStore("media").put({ ...media, operationId: operation.operationId }),
    tx.objectStore("operations").put(operation),
    tx.done,
  ]);
}

export async function getOfflineEntitiesForOpening(openingId: string) {
  const db = await getDb();
  return db.getAllFromIndex("entities", "by-opening", openingId);
}

export async function getSyncOperationsForOpening(openingId: string) {
  const db = await getDb();
  return db.getAllFromIndex("operations", "by-opening", openingId);
}

export async function getAllSyncOperations() {
  const db = await getDb();
  return db.getAll("operations");
}

export async function getSyncOperationsForPrincipal(userId: string, organizationId: string) {
  return (await getAllSyncOperations()).filter(
    (operation) => operation.actorUserId === userId && operation.organizationId === organizationId,
  );
}

export async function getOpenConflictsForPrincipal(userId: string, organizationId: string) {
  const db = await getDb();
  const conflicts = await db.getAll("conflicts");
  const operations = await db.getAll("operations");
  const owned = new Set(operations.filter((operation) =>
    operation.actorUserId === userId && operation.organizationId === organizationId).map((operation) => operation.operationId));
  return conflicts.filter((conflict) => conflict.resolutionState === "open" && owned.has(conflict.operationId));
}

export async function getOfflineMediaForPrincipal(userId: string, organizationId: string) {
  const db = await getDb();
  return (await db.getAll("media")).filter(
    (media) => media.capturedByUserId === userId && media.organizationId === organizationId,
  );
}

export async function claimSyncOperation(input: {
  operationId: string;
  userId: string;
  organizationId: string;
  leaseId: string;
  nowIso: string;
  leaseDurationMs: number;
}) {
  const db = await getDb();
  const tx = db.transaction(["auth", "operations", "syncReceipts"], "readwrite");
  const auth = await tx.objectStore("auth").get("current");
  const operation = await tx.objectStore("operations").get(input.operationId);
  if (!auth || auth.userId !== input.userId || auth.organizationId !== input.organizationId ||
      !operation || operation.actorUserId !== input.userId || operation.organizationId !== input.organizationId) {
    await tx.done;
    return undefined;
  }
  const now = Date.parse(input.nowIso);
  const staleLease = interruptedOperationIsRecoverable(operation, input.nowIso);
  if (!["queued", "retry_wait", "blocked_dependency"].includes(operation.state) && !staleLease) {
    await tx.done;
    return undefined;
  }
  if (operation.nextAttemptAt && Date.parse(operation.nextAttemptAt) > now) {
    await tx.done;
    return undefined;
  }
  for (const dependencyId of operation.dependencyOperationIds) {
    if (!(await tx.objectStore("syncReceipts").get(dependencyId))) {
      await tx.done;
      return undefined;
    }
  }
  const claimed = { ...operation, state: "in_flight" as const, lastAttemptAt: input.nowIso,
    dispatchLeaseId: input.leaseId,
    dispatchLeaseExpiresAt: new Date(now + input.leaseDurationMs).toISOString() };
  await tx.objectStore("operations").put(claimed);
  await tx.done;
  return claimed;
}

export async function retrySyncOperationAfterReview(
  operationId: string,
  resolveConflict = false,
  nowIso = new Date().toISOString(),
) {
  const db = await getDb();
  const tx = db.transaction(["auth", "operations", "conflicts"], "readwrite");
  const auth = await tx.objectStore("auth").get("current");
  const operation = await tx.objectStore("operations").get(operationId);
  if (!auth || !operation || operation.actorUserId !== auth.userId || operation.organizationId !== auth.organizationId) {
    throw new Error("operation_principal_mismatch");
  }
  if (operation.state === "conflict") {
    if (!resolveConflict) throw new Error("conflict_review_required");
    const conflicts = await tx.objectStore("conflicts").getAll();
    const conflict = conflicts.find((item) => item.operationId === operationId && item.resolutionState === "open");
    if (!conflict) throw new Error("open_conflict_not_found");
    await tx.objectStore("conflicts").put({ ...conflict, resolutionState: "resolved",
      resolvedByUserId: auth.userId, selectedOutcome: "local", resolvedAt: new Date().toISOString() });
  } else if (!["auth_required", "retry_wait", "permanent_failure"].includes(operation.state) &&
      !interruptedOperationIsRecoverable(operation, nowIso)) {
    throw new Error("operation_not_reviewable");
  }
  await tx.objectStore("operations").put({ ...operation, state: "queued", nextAttemptAt: undefined,
    dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined, lastErrorCode: undefined });
  await tx.done;
}

export async function recoverOrphanedMediaOperation(photoId: string) {
  const db = await getDb();
  const tx = db.transaction(["auth", "media", "operations"], "readwrite");
  const auth = await tx.objectStore("auth").get("current");
  const media = await tx.objectStore("media").get(photoId);
  if (!auth || !media || media.capturedByUserId !== auth.userId || media.organizationId !== auth.organizationId) {
    throw new Error("media_principal_mismatch");
  }
  const operations = await tx.objectStore("operations").getAll();
  if (operations.some((operation) => operation.entityType === "photo" && operation.entityId === photoId)) {
    throw new Error("media_operation_already_exists");
  }
  const operationId = media.operationId ?? media.photoId;
  if (operations.some((operation) => operation.operationId === operationId)) {
    throw new Error("media_operation_identity_conflict");
  }
  const dependencies = media.targetType === "opening" ? [] : operations
    .filter((operation) => operation.openingId === media.openingId && operation.entityId === media.targetId &&
      operation.state !== "verified")
    .map((operation) => operation.operationId);
  const legacyIdentityRecovery = !media.operationId;
  const operation: SyncOperation = {
    operationId,
    operationType: "confirm_media",
    entityType: "photo",
    entityId: media.photoId,
    openingId: media.openingId,
    organizationId: media.organizationId,
    actorUserId: media.capturedByUserId,
    deviceId: media.capturedByDeviceId,
    baseServerRevision: null,
    payload: {
      target_type: media.targetType,
      target_id: media.targetId,
      original_filename: media.originalFilename,
      content_type: media.contentType,
      byte_size: media.byteSize,
      sha256_checksum: media.sha256Checksum,
      latitude: media.latitude,
      longitude: media.longitude,
      legacy_identity_recovery: legacyIdentityRecovery,
    },
    payloadHash: media.sha256Checksum,
    dependencyOperationIds: [...new Set(dependencies)],
    createdAtLocal: media.createdAtLocal,
    state: dependencies.length ? "blocked_dependency" : "queued",
    attemptCount: 0,
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    appVersion: "offline-protocol-1",
    protocolVersion: SYNC_PROTOCOL_VERSION,
  };
  await tx.objectStore("operations").put(operation);
  await tx.objectStore("media").put({ ...media, operationId: operation.operationId,
    uploadState: operation.state, updatedAtLocal: new Date().toISOString() });
  await tx.done;
  return operation;
}

export async function reconcileRecoveredMediaOperationId(oldOperationId: string, recoveredOperationId: string) {
  if (oldOperationId === recoveredOperationId) {
    const db = await getDb();
    return db.get("operations", oldOperationId);
  }
  const db = await getDb();
  const tx = db.transaction(["auth", "media", "operations"], "readwrite");
  const auth = await tx.objectStore("auth").get("current");
  const operation = await tx.objectStore("operations").get(oldOperationId);
  if (!auth || !operation || operation.entityType !== "photo" ||
      operation.actorUserId !== auth.userId || operation.organizationId !== auth.organizationId) {
    throw new Error("operation_principal_mismatch");
  }
  if (await tx.objectStore("operations").get(recoveredOperationId)) {
    throw new Error("recovered_operation_identity_conflict");
  }
  const media = await tx.objectStore("media").get(operation.entityId);
  if (!media || media.photoId !== operation.entityId) throw new Error("receipt_media_not_found");
  const reconciled: SyncOperation = { ...operation, operationId: recoveredOperationId,
    payload: { ...(operation.payload as Record<string, unknown>), legacy_identity_recovery: false } };
  await tx.objectStore("operations").delete(oldOperationId);
  await tx.objectStore("operations").put(reconciled);
  await tx.objectStore("media").put({ ...media, operationId: recoveredOperationId,
    updatedAtLocal: new Date().toISOString() });
  const allOperations = await tx.objectStore("operations").getAll();
  for (const dependent of allOperations) {
    if (!dependent.dependencyOperationIds.includes(oldOperationId)) continue;
    await tx.objectStore("operations").put({ ...dependent, dependencyOperationIds:
      dependent.dependencyOperationIds.map((id) => id === oldOperationId ? recoveredOperationId : id) });
  }
  await tx.done;
  return reconciled;
}

export async function putSyncOperation(operation: SyncOperation) {
  const db = await getDb();
  await db.put("operations", operation);
}

export async function getOfflineMedia(photoId: string) {
  const db = await getDb();
  return db.get("media", photoId);
}

export async function getAllOfflineMedia() {
  const db = await getDb();
  return db.getAll("media");
}

export async function removeVerifiedLocalOriginal(photoId: string) {
  const db = await getDb();
  const tx = db.transaction(["media", "syncReceipts"], "readwrite");
  const media = await tx.objectStore("media").get(photoId);
  if (!media || media.localBlobState !== "verified_cleanup_allowed") {
    throw new Error("local_original_not_verified_for_cleanup");
  }
  const receipts = await tx.objectStore("syncReceipts").index("by-entity").getAll(photoId);
  if (!receipts.some((receipt) => receipt.mediaObjectVerified && receipt.authorizedRetrievalVerified)) {
    throw new Error("local_original_receipt_proof_missing");
  }
  await tx.objectStore("media").delete(photoId);
  await tx.done;
}

export async function putSyncReceipt(receipt: SyncReceipt) {
  const db = await getDb();
  const tx = db.transaction(["syncReceipts", "operations", "entities", "media"], "readwrite");
  const operation = await tx.objectStore("operations").get(receipt.operationId);
  if (!operation) throw new Error("receipt_operation_not_found");
  if (
    operation.entityId !== receipt.entityId ||
    operation.openingId !== receipt.openingId ||
    operation.organizationId !== receipt.organizationId
  ) {
    throw new Error("receipt_identity_mismatch");
  }
  if (operation.entityType === "photo") {
    const media = await tx.objectStore("media").get(operation.entityId);
    if (!media) throw new Error("receipt_media_not_found");
    if (!receipt.mediaObjectVerified || !receipt.authorizedRetrievalVerified) {
      throw new Error("receipt_media_proof_incomplete");
    }
    await tx.objectStore("media").put({
      ...media,
      uploadState: "verified",
      serverPhotoRevision: receipt.serverRevision,
      localBlobState: "verified_cleanup_allowed",
      updatedAtLocal: receipt.verifiedAt,
    });
  } else {
    const key = entityKey(operation.entityType, operation.entityId);
    const entity = await tx.objectStore("entities").get(key);
    if (!entity) throw new Error("receipt_entity_not_found");
    await tx.objectStore("entities").put({
      ...entity,
      syncState: "verified",
      serverRevision: receipt.serverRevision,
      lastErrorCode: undefined,
      updatedAtLocal: receipt.verifiedAt,
    });
  }
  await tx.objectStore("syncReceipts").put(receipt);
  await tx.objectStore("operations").put({ ...operation, state: "verified", lastErrorCode: undefined,
    dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined });
  await tx.done;
}

export async function putSyncConflict(conflict: SyncConflict) {
  const db = await getDb();
  const tx = db.transaction(["conflicts", "operations", "entities", "media"], "readwrite");
  const operation = await tx.objectStore("operations").get(conflict.operationId);
  if (!operation) throw new Error("conflict_operation_not_found");
  if (operation.entityType === "photo") {
    const media = await tx.objectStore("media").get(operation.entityId);
    if (!media) throw new Error("conflict_media_not_found");
    await tx.objectStore("media").put({ ...media, uploadState: "conflict", updatedAtLocal: conflict.detectedAt });
  } else {
    const key = entityKey(operation.entityType, operation.entityId);
    const entity = await tx.objectStore("entities").get(key);
    if (!entity) throw new Error("conflict_entity_not_found");
    await tx.objectStore("entities").put({ ...entity, syncState: "conflict", updatedAtLocal: conflict.detectedAt });
  }
  await tx.objectStore("conflicts").put(conflict);
  await tx.objectStore("operations").put({ ...operation, state: "conflict",
    dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined });
  await tx.done;
}

export async function putOpeningSnapshot(snapshot: OpeningSnapshot) {
  const db = await getDb();
  await db.put("openingSnapshots", snapshot);
}

export async function putOfflineSetting(setting: OfflineSetting) {
  const db = await getDb();
  await db.put("settings", setting);
}

export async function getOfflineSetting(key: string) {
  const db = await getDb();
  return db.get("settings", key);
}

export async function cacheOpening(opening: any, principal?: {userId:string;organizationId:string}) {
  const db = await getDb();
  const auth = await loadAuth();
  const owner=principal||auth;
  if(!owner||!auth||auth.userId!==owner.userId||auth.organizationId!==owner.organizationId)return;
  await db.put("openings", {...opening,_cacheUserId:owner.userId,_cacheOrganizationId:owner.organizationId});
}

export async function getCachedOpening(id: string) {
  const db = await getDb();
  const auth=await loadAuth();
  const row=await db.get("openings", id);
  if(!auth||row?._cacheUserId!==auth.userId||row?._cacheOrganizationId!==auth.organizationId)return undefined;
  return row;
}

export async function updateCachedOpening(id: string, updater: (opening: any) => any) {
  const db = await getDb();
  const current = await db.get("openings", id);
  if (!current) return;
  await db.put("openings", updater(current));
}

export async function enqueueOutboxItem(item: Omit<OutboxItem, "attempts" | "createdAt" | "status">) {
  const db = await getDb();
  await db.put("outbox", { ...item, attempts: 0, status: "pending", createdAt: Date.now() });
}

export async function getOutbox(): Promise<OutboxItem[]> {
  const db = await getDb();
  return (await db.getAll("outbox")).map((item) => ({ ...item, status: item.status || "pending" }));
}

export async function removeOutboxItem(id: string) {
  const db = await getDb();
  await db.delete("outbox", id);
}

export async function updateOutboxItem(item: OutboxItem) {
  const db = await getDb();
  await db.put("outbox", item);
}

export async function enqueuePhotoOutboxItem(item: Omit<PhotoOutboxItem, "attempts" | "createdAt" | "status">) {
  const db = await getDb();
  await db.put("photoOutbox", { ...item, attempts: 0, status: "pending", createdAt: Date.now() });
}

export async function getPhotoOutbox(): Promise<PhotoOutboxItem[]> {
  const db = await getDb();
  return (await db.getAll("photoOutbox")).map((item) => ({
    ...item,
    status: item.status || "pending",
    relatedEntityType: item.relatedEntityType || "opening",
  }));
}

export async function getPhotoOutboxForOpening(openingId: string): Promise<PhotoOutboxItem[]> {
  const all = await getPhotoOutbox();
  return all.filter((p) => p.openingId === openingId);
}

export async function removePhotoOutboxItem(id: string) {
  const db = await getDb();
  await db.delete("photoOutbox", id);
}

export async function updatePhotoOutboxItem(item: PhotoOutboxItem) {
  const db = await getDb();
  await db.put("photoOutbox", item);
}

export async function retryOutboxItem(id: string, photo: boolean) {
  const db = await getDb();
  if (photo) {
    const item = await db.get("photoOutbox", id);
    if (item) await db.put("photoOutbox", { ...item, status: "pending", lastError: undefined });
    return;
  }
  const item = await db.get("outbox", id);
  if (item) await db.put("outbox", { ...item, status: "pending", lastError: undefined });
}

export async function saveAuth(auth: { token: string; userId: string; organizationId: string; role: string }) {
  const db = await getDb();
  await db.put("auth", { ...auth, savedAt: Date.now() }, "current");
}

export async function loadAuth() {
  const db = await getDb();
  return db.get("auth", "current");
}

export async function clearAuth() {
  const db = await getDb();
  await db.delete("auth", "current");
}
