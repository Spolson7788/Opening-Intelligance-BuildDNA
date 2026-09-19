import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import { entityKey, OFFLINE_SCHEMA_VERSION } from "./offlineTypes";
import type {
  OfflineEntityEnvelope,
  OfflineMediaRecord,
  OfflineSetting,
  OpeningSnapshot,
  SyncConflict,
  SyncOperation,
  SyncReceipt,
} from "./offlineTypes";

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
    tx.objectStore("media").put(media),
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
  await tx.objectStore("operations").put({ ...operation, state: "verified", lastErrorCode: undefined });
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
  await tx.objectStore("operations").put({ ...operation, state: "conflict" });
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

export async function cacheOpening(opening: any) {
  const db = await getDb();
  await db.put("openings", opening);
}

export async function getCachedOpening(id: string) {
  const db = await getDb();
  return db.get("openings", id);
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
