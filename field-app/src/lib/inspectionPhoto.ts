import { getOfflineMedia, loadAuth, saveMediaAndOperation } from "./db";
import { checksumBlob, getOrCreateDeviceId, noteSyncDiagnostic, refreshPendingCount } from "./sync";
import { DEVICE_STORAGE_MESSAGE, isDeviceStorageError } from "./storageErrors";
import { formatMegabytes, MAX_IMAGE_BYTES, MEDIA_TOO_LARGE } from "./mediaLimits";
import { prepareImageForUpload, reducedFilename } from "./photoPreparation";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "./offlineTypes";
import type { OfflineMediaRecord, SyncOperation } from "./offlineTypes";

export const PHOTO_UNREADABLE_MESSAGE = "The failure photo could not be read. Choose it again. The inspection was not saved.";
const LOW_STORAGE_BYTES = 5 * 1024 * 1024;

/** Save-screen text. An unreadable photo is the only case that says the photo could not be read. */
export function inspectionSaveFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "auth_required") return "Sign in again before saving this inspection. The inspection was not saved.";
  if (message === "photo_unreadable") return PHOTO_UNREADABLE_MESSAGE;
  if (/row-level security|internal_error/i.test(message)) {
    return "The server rejected this queued inspection. It remains saved on this device.";
  }
  if (isDeviceStorageError(error)) return DEVICE_STORAGE_MESSAGE;
  return "This device could not queue the inspection. Try again. The inspection was not saved.";
}

export async function lowStorageWarning(): Promise<string | null> {
  const estimate = navigator.storage?.estimate;
  if (!estimate) return null;
  try {
    const { quota, usage } = await estimate.call(navigator.storage);
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
    await saveMediaAndOperation(media, operation);
    await refreshPendingCount();
  } catch (error) {
    noteSyncDiagnostic(error);
    const message = inspectionSaveFailureMessage(error);
    return { kind: message.startsWith("Sign in") ? "auth" as const : "device" as const, message, photoId };
  }
  if (rejected) {
    return { kind: "kept" as const, message: `This photograph is ${formatMegabytes(file.size)}, above the ${formatMegabytes(MAX_IMAGE_BYTES)} upload limit, and this device could not make a smaller copy. It is kept on this device: open Synchronization review to save a copy or remove it. The inspection was not saved.` };
  }
  return { kind: "queued" as const, photoId };
}
