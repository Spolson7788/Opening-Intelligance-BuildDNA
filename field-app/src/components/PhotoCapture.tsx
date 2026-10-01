import { useState } from "react";
import { getAllSyncOperations, loadAuth, saveMediaAndOperation } from "../lib/db";
import { checksumBlob, dependencyIdsForOperation, flushOutbox, getOrCreateDeviceId } from "../lib/sync";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../lib/offlineTypes";
import { formatMegabytes, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MEDIA_TOO_LARGE } from "../lib/mediaLimits";
import { prepareImageForUpload, reducedFilename } from "../lib/photoPreparation";
import type { OfflineMediaRecord, SyncOperation } from "../lib/offlineTypes";

interface Props {
  openingId: string;
  relatedEntityType?: "opening" | "frame" | "door_leaf" | "hardware_component";
  relatedEntityId?: string;
  onQueued: () => void; // fires the instant a photo/video is saved locally, not once it's uploaded
}

// Size limits come from lib/mediaLimits.ts, which a test keeps equal to the
// API's limits in src/services/storage.ts.

// The opening page re-renders its loading view after each synchronization pass, which remounts this
// component. Capture outcomes (a reduction notice or a size refusal) are kept here briefly per input so
// the technician still sees them after that remount.
const MESSAGE_TTL_MS = 2 * 60_000;
const recentMessages = new Map<string, { error: string | null; notice: string | null; at: number }>();
function recentMessage(key: string) {
  const entry = recentMessages.get(key);
  return entry && Date.now() - entry.at < MESSAGE_TTL_MS ? entry : undefined;
}

export function PhotoCapture({ openingId, relatedEntityType = "opening", relatedEntityId, onQueued }: Props) {
  const inputSuffix = `${openingId}-${relatedEntityType}-${relatedEntityId ?? openingId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const [saving, setSaving] = useState(false);
  const [error, setErrorState] = useState<string | null>(() => recentMessage(inputSuffix)?.error ?? null);
  const [notice, setNoticeState] = useState<string | null>(() => recentMessage(inputSuffix)?.notice ?? null);
  const setError = (value: string | null) => {
    setErrorState(value);
    recentMessages.set(inputSuffix, { error: value, notice: value ? null : recentMessage(inputSuffix)?.notice ?? null, at: Date.now() });
  };
  const setNotice = (value: string | null) => {
    setNoticeState(value);
    recentMessages.set(inputSuffix, { notice: value, error: value ? null : recentMessage(inputSuffix)?.error ?? null, at: Date.now() });
  };

  function getLocation(): Promise<{ latitude?: number; longitude?: number }> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({});
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve({}), // geotagging is a nice-to-have, never block the capture on it
        { timeout: 3000 }
      );
    });
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow selecting the same file again later
    if (!file) return;
    setError(null);
    setNotice(null);

    const isVideo = file.type.startsWith("video/");
    if (isVideo && file.size > MAX_VIDEO_BYTES) {
      setError(`That video is too large (${formatMegabytes(file.size)}) — ${formatMegabytes(MAX_VIDEO_BYTES)} max. Try a shorter clip.`);
      return;
    }

    setSaving(true);
    try {
      // Photographs above the upload limit are reduced to a JPEG copy that
      // fits. If that is impossible on this device, the original is still
      // kept locally and listed in Synchronization review (never discarded,
      // never retried indefinitely).
      const prepared = isVideo
        ? { blob: file as Blob, contentType: file.type, reduced: false, withinLimit: true, sourceBytes: file.size }
        : await prepareImageForUpload(file, MAX_IMAGE_BYTES);
      const blob = prepared.blob;
      const contentType = prepared.contentType || file.type;
      const filename = prepared.reduced ? reducedFilename(file.name) : file.name;
      const rejected = !prepared.withinLimit;
      // Save the blob to IndexedDB immediately — this is the offline-safe step.
      // Upload happens later via the same outbox-flush mechanism as service/
      // inspection events, so this button behaves consistently with the rest
      // of the app regardless of connectivity, and regardless of whether it's
      // a photo or a video.
      const location = await getLocation();
      const auth = await loadAuth();
      if (!auth) throw new Error("auth_required");
      const now = new Date().toISOString();
      const photoId = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      const deviceId = await getOrCreateDeviceId();
      const checksum = await checksumBlob(blob);
      const targetId = relatedEntityId ?? openingId;
      const dependencies = dependencyIdsForOperation(await getAllSyncOperations(), "photo", openingId, {
        target_type: relatedEntityType, target_id: targetId,
      });
      const media: OfflineMediaRecord = {
        photoId, openingId, organizationId: auth.organizationId,
        targetType: relatedEntityType, targetId, capturedAtDevice: now,
        capturedByUserId: auth.userId, capturedByDeviceId: deviceId,
        originalFilename: filename, generatedCaptureName: `${photoId}.${contentType.split("/")[1] || "bin"}`,
        contentType, byteSize: blob.size, sha256Checksum: checksum, blob,
        widthPixels: "width" in prepared ? prepared.width : undefined, heightPixels: "height" in prepared ? prepared.height : undefined,
        latitude: location.latitude, longitude: location.longitude,
        localBlobState: "retained", uploadState: rejected ? "permanent_failure" : "queued", provenanceState: "original",
        reviewState: "pending", createdAtLocal: now, updatedAtLocal: now,
      };
      const operation: SyncOperation = {
        operationId, operationType: "confirm_media", entityType: "photo", entityId: photoId,
        openingId, organizationId: auth.organizationId, actorUserId: auth.userId, deviceId,
        baseServerRevision: null, payload: { target_type: relatedEntityType, target_id: targetId,
          original_filename: filename, content_type: contentType, byte_size: blob.size, sha256_checksum: checksum,
          latitude: location.latitude, longitude: location.longitude },
        payloadHash: checksum, dependencyOperationIds: dependencies, createdAtLocal: now,
        state: rejected ? "permanent_failure" : dependencies.length ? "blocked_dependency" : "queued", attemptCount: 0,
        lastErrorCode: rejected ? MEDIA_TOO_LARGE : undefined,
        schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "offline-protocol-1", protocolVersion: SYNC_PROTOCOL_VERSION,
      };
      await saveMediaAndOperation(media, operation);
      if (rejected) {
        setError(`This photograph is ${formatMegabytes(file.size)}, above the ${formatMegabytes(MAX_IMAGE_BYTES)} upload limit, and this device could not make a smaller copy. It is kept on this device: open Synchronization review to save a copy or remove it.`);
      } else if (prepared.reduced) {
        setNotice(`Photograph reduced from ${formatMegabytes(prepared.sourceBytes)} to ${formatMegabytes(blob.size)} to fit the ${formatMegabytes(MAX_IMAGE_BYTES)} upload limit.`);
      }
      onQueued();
      flushOutbox(); // fire-and-forget: uploads now if online, otherwise sits queued
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <label htmlFor={`photo-input-${inputSuffix}`} className="btn btn-secondary" style={{ cursor: "pointer" }}>
          {saving ? "Saving…" : "+ Add Photo"}
          <input
            id={`photo-input-${inputSuffix}`}
            aria-label="Choose photograph"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFileSelected}
            disabled={saving}
            style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}
          />
        </label>
        <label htmlFor={`video-input-${inputSuffix}`} className="btn btn-secondary" style={{ cursor: "pointer" }}>
          {saving ? "Saving…" : "+ Add Video"}
          <input
            id={`video-input-${inputSuffix}`}
            aria-label="Choose video"
            type="file"
            accept="video/mp4,video/quicktime"
            capture="environment"
            onChange={onFileSelected}
            disabled={saving}
            style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}
          />
        </label>
      </div>
      {notice && <p role="status" style={{ marginTop: 8, color: "var(--text-secondary)" }}>{notice}</p>}
      {error && <p className="error-text" role="alert" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}
