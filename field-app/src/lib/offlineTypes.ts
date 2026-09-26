export const OFFLINE_SCHEMA_VERSION = 3;
export const SYNC_PROTOCOL_VERSION = 1;

export type OfflineEntityType =
  | "opening"
  | "frame"
  | "door_leaf"
  | "component"
  | "photo"
  | "service_event"
  | "inspection_event"
  | "completion"
  | "purchasing_review";

export type SyncOperationType =
  | "create"
  | "update"
  | "complete"
  | "upload_media"
  | "confirm_media"
  | "tombstone";

export type SyncOperationState =
  | "local_committed"
  | "queued"
  | "retry_wait"
  | "blocked_dependency"
  | "in_flight"
  | "verifying"
  | "verified"
  | "permanent_failure"
  | "auth_required"
  | "storage_pressure"
  | "schema_blocked"
  | "conflict";

export type TechnicianSyncStatus =
  | "saved_locally"
  | "waiting_to_sync"
  | "syncing"
  | "synced"
  | "needs_attention"
  | "conflict_requires_review";

export interface OfflineEntityEnvelope<TPayload = Record<string, unknown>> {
  key: string;
  id: string;
  entityType: OfflineEntityType;
  organizationId: string;
  facilityId?: string;
  openingId: string;
  parentEntityId?: string;
  createdByUserId: string;
  createdByDeviceId: string;
  createdAtLocal: string;
  updatedAtLocal: string;
  serverRevision: number | null;
  baseSnapshotHash: string | null;
  schemaVersion: number;
  appVersion: string;
  syncState: SyncOperationState;
  lastSyncAttemptAt?: string;
  retryCount: number;
  lastErrorCode?: string;
  payload: TPayload;
}

export interface SyncOperation<TPayload = Record<string, unknown>> {
  operationId: string;
  operationType: SyncOperationType;
  entityType: OfflineEntityType;
  entityId: string;
  openingId: string;
  organizationId: string;
  actorUserId: string;
  deviceId: string;
  baseServerRevision: number | null;
  payload: TPayload;
  payloadHash: string;
  dependencyOperationIds: string[];
  createdAtLocal: string;
  state: SyncOperationState;
  attemptCount: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  dispatchLeaseId?: string;
  dispatchLeaseExpiresAt?: string;
  lastErrorCode?: string;
  schemaVersion: number;
  appVersion: string;
  protocolVersion: number;
}

export type MediaTargetType =
  | "opening"
  | "frame"
  | "door_leaf"
  | "hardware_component"
  | "service_event"
  | "inspection_event";

export interface OfflineMediaRecord {
  photoId: string;
  operationId?: string;
  openingId: string;
  organizationId: string;
  targetType: MediaTargetType;
  targetId: string;
  capturedAtDevice: string;
  capturedByUserId: string;
  capturedByDeviceId: string;
  originalFilename: string;
  generatedCaptureName: string;
  contentType: string;
  byteSize: number;
  sha256Checksum: string;
  widthPixels?: number;
  heightPixels?: number;
  latitude?: number;
  longitude?: number;
  blob: Blob;
  localBlobState: "retained" | "verified_cleanup_allowed";
  uploadState: SyncOperationState;
  storageObjectKey?: string;
  serverPhotoRevision?: number;
  provenanceState: "original" | "derived";
  reviewState: "pending" | "reviewed";
  derivedFromPhotoId?: string;
  createdAtLocal: string;
  updatedAtLocal: string;
}

export interface SyncReceipt {
  operationId: string;
  entityId: string;
  entityType: OfflineEntityType;
  openingId: string;
  organizationId: string;
  serverRevision: number;
  normalizedRecordHash: string;
  serverAcceptedAt: string;
  verifiedAt: string;
  mediaObjectVerified?: boolean;
  authorizedRetrievalVerified?: boolean;
}

export interface SyncConflict {
  conflictId: string;
  operationId: string;
  entityId: string;
  openingId: string;
  organizationId: string;
  affectedFields: string[];
  baseValues: Record<string, unknown>;
  localValues: Record<string, unknown>;
  serverValues: Record<string, unknown>;
  detectedAt: string;
  resolutionState: "open" | "resolved";
  resolvedByUserId?: string;
  selectedOutcome?: "local" | "server" | "edited";
  resolvedAt?: string;
}

export interface OpeningSnapshot {
  openingId: string;
  organizationId: string;
  serverRevision: number;
  normalizedRecordHash: string;
  downloadedAt: string;
  hierarchy: Record<string, unknown>;
}

export interface OfflineSetting {
  key: string;
  value: unknown;
  updatedAt: string;
}

export function entityKey(entityType: OfflineEntityType, id: string): string {
  return `${entityType}:${id}`;
}
