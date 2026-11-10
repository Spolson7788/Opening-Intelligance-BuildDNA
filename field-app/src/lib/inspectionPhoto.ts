import { getOfflineMedia, loadAuth, resetFieldAppDb, saveMediaAndOperation } from "./db";
import { checksumBlob, getOrCreateDeviceId, noteSyncDiagnostic, refreshPendingCount, runLocalWrite } from "./sync";
import { ApiError, confirmOfflinePhoto, reserveOfflinePhoto, uploadPrivatePhoto } from "./api";
import { withTimeout } from "./deadline";
import { DEVICE_STORAGE_MESSAGE, isDeviceStorageError, storageDiagnostic } from "./storageErrors";
import { formatMegabytes, MAX_IMAGE_BYTES, MEDIA_TOO_LARGE } from "./mediaLimits";
import { prepareImageForUpload, reducedFilename } from "./photoPreparation";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "./offlineTypes";
import type { OfflineMediaRecord, SyncOperation } from "./offlineTypes";

export const PHOTO_UNREADABLE_MESSAGE = "The failure photo could not be read. Choose it again. The inspection was not saved.";
const LOW_STORAGE_BYTES = 5 * 1024 * 1024;

const NAMED_STORAGE = new Set(["DataCloneError", "NotFoundError", "TransactionInactiveError", "SecurityError"]);

function browserIsOnline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === true;
}

/** Save-screen text. An unreadable photo is the only case that says the photo could not be read. */
export function inspectionSaveFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const name = error instanceof Error ? error.name : "";
  const detail = storageDiagnostic(error);
  if (message === "auth_required") return "Sign in again before saving this inspection. The inspection was not saved.";
  if (message === "active_principal_changed") return `Sign in again before saving this inspection (${detail}). The inspection was not saved.`;
  if (message === "photo_unreadable") return PHOTO_UNREADABLE_MESSAGE;
  if (message === "oi_data_wiped") return `This device cleared its saved inspections (${detail}). Sign in again. The inspection was not saved.`;
  if (message === "media_operation_identity_mismatch" || message === "media_operation_tenant_mismatch") {
    return `This device could not queue the inspection (${detail}). Try again. The inspection was not saved.`;
  }
  if (error instanceof ApiError) return `The server did not save this inspection (${error.status}: ${message}). The inspection was not saved.`;
  if (name === "TimeoutError" || /timed out|open blocked/i.test(message)) {
    const sent = error instanceof Error && (error as Error & { sentToServer?: boolean }).sentToServer === true;
    if (sent) return `This device could not queue the inspection (${detail}). The same inspection was sent to the server. Save is available if you need to try again.`;
    return `This device could not queue the inspection (${detail}). Try again. The inspection was not saved.`;
  }
  if (/row-level security|\binternal_error\b/i.test(message)) {
    return "The server rejected this queued inspection. It remains saved on this device.";
  }
  const namedStorage = NAMED_STORAGE.has(name) || /internal error/i.test(message)
    || (/indexed database/i.test(message) && !/connection to indexed database server lost/i.test(message));
  if (namedStorage) return `${DEVICE_STORAGE_MESSAGE} (${detail})`;
  if (isDeviceStorageError(error)) return DEVICE_STORAGE_MESSAGE;
  return `This device could not queue the inspection (${detail}). Try again. The inspection was not saved.`;
}

const ESTIMATE_TIMEOUT_MS = 2_000;

export async function lowStorageWarning(): Promise<string | null> {
  const estimate = navigator.storage?.estimate;
  if (!estimate) return null;
  try {
    const { quota, usage } = await withTimeout(Promise.resolve(estimate.call(navigator.storage)), ESTIMATE_TIMEOUT_MS, "storage estimate timed out");
    if (quota == null || usage == null || quota <= 0) return null;
    const free = quota - usage;
    if (free < LOW_STORAGE_BYTES || usage / quota > 0.95) {
      return "This device is almost out of storage. Free some space, then try again. Your entries stay on this screen.";
    }
  } catch { /* estimate is optional */ }
  return null;
}

export async function queueInspectionFailurePhoto(openingId: string, file: Blob, filename: string, reuse?: { photoId: string; operationId: string }) {
  const auth = await loadAuth();
  if (!auth) return { kind: "auth" as const, message: inspectionSaveFailureMessage(new Error("auth_required")) };
  let prepared;
  try {
    prepared = await prepareImageForUpload(file, MAX_IMAGE_BYTES);
  } catch {
    return { kind: "unreadable" as const, message: PHOTO_UNREADABLE_MESSAGE };
  }
  const photoId = reuse?.photoId ?? crypto.randomUUID();
  const operationId = reuse?.operationId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const contentType = prepared.contentType || (file.type.startsWith("image/") ? file.type : "image/jpeg");
  const blob = prepared.blob;
  const rejected = !prepared.withinLimit;
  let checksum: string;
  try {
    checksum = await checksumBlob(blob);
  } catch {
    return { kind: "unreadable" as const, message: PHOTO_UNREADABLE_MESSAGE };
  }
  const already = await getOfflineMedia(photoId).catch(() => undefined);
  if (already && already.openingId === openingId && already.sha256Checksum === checksum) {
    return { kind: "queued" as const, photoId };
  }
  const deviceId = await getOrCreateDeviceId();
  const media: OfflineMediaRecord = {
    photoId, openingId, organizationId: auth.organizationId,
    targetType: "opening", targetId: openingId, capturedAtDevice: now,
    capturedByUserId: auth.userId, capturedByDeviceId: deviceId,
    originalFilename: prepared.reduced ? reducedFilename(filename) : filename,
    generatedCaptureName: `${photoId}.${contentType.split("/")[1] || "bin"}`,
    contentType, byteSize: blob.size, sha256Checksum: checksum, blob,
    widthPixels: prepared.width, heightPixels: prepared.height,
    localBlobState: "retained", uploadState: rejected ? "permanent_failure" : "queued",
    provenanceState: "original", reviewState: "pending", createdAtLocal: now, updatedAtLocal: now,
  };
  const operation: SyncOperation = {
    operationId, operationType: "confirm_media", entityType: "photo", entityId: photoId,
    openingId, organizationId: auth.organizationId, actorUserId: auth.userId, deviceId,
    baseServerRevision: null,
    payload: { target_type: "opening", target_id: openingId, original_filename: media.originalFilename,
      content_type: contentType, byte_size: blob.size, sha256_checksum: checksum },
    payloadHash: checksum, dependencyOperationIds: [], createdAtLocal: now,
    state: rejected ? "permanent_failure" : "queued", attemptCount: 0,
    lastErrorCode: rejected ? MEDIA_TOO_LARGE : undefined,
    schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "offline-protocol-1", protocolVersion: SYNC_PROTOCOL_VERSION,
  };
  try {
    await runLocalWrite(() => saveMediaAndOperation(media, operation));
    await refreshPendingCount();
  } catch (error) {
    noteSyncDiagnostic(error, true);
    await resetFieldAppDb();
    if (!rejected && browserIsOnline()) {
      try {
        await uploadFailurePhotoDirect(media, operation);
        return { kind: "queued" as const, photoId };
      } catch (uploadError) {
        noteSyncDiagnostic(uploadError, true);
        return { kind: "device" as const, message: inspectionSaveFailureMessage(uploadError), photoId };
      }
    }
    const message = inspectionSaveFailureMessage(error);
    return { kind: message.startsWith("Sign in") ? "auth" as const : "device" as const, message, photoId };
  }
  if (rejected) {
    return { kind: "kept" as const, message: `This photograph is ${formatMegabytes(file.size)}, above the ${formatMegabytes(MAX_IMAGE_BYTES)} upload limit, and this device could not make a smaller copy. It is kept on this device: open Synchronization review to save a copy or remove it. The inspection was not saved.` };
  }
  return { kind: "queued" as const, photoId };
}

async function uploadFailurePhotoDirect(media: OfflineMediaRecord, operation: SyncOperation) {
  const principal = { userId: media.capturedByUserId, organizationId: media.organizationId };
  const reservation = await reserveOfflinePhoto({
    photo_id: media.photoId, client_operation_id: operation.operationId,
    opening_id: media.openingId, target_type: "opening", target_id: media.targetId,
    original_filename: media.originalFilename, content_type: media.contentType,
    byte_size: media.byteSize, sha256_checksum: media.sha256Checksum, device_id: media.capturedByDeviceId,
  }, principal);
  if (reservation.status !== "verified") {
    if (!reservation.upload_url) throw new Error("photo_upload_authority_missing");
    await uploadPrivatePhoto(reservation.upload_url, media.blob, media.contentType, media.sha256Checksum, media.photoId);
  }
  await confirmOfflinePhoto({
    photo_id: media.photoId, client_operation_id: operation.operationId,
    schema_version: operation.schemaVersion, app_version: operation.appVersion, protocol_version: operation.protocolVersion,
  }, principal);
}
