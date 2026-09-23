import { useState } from "react";
import { getAllSyncOperations, loadAuth, saveMediaAndOperation } from "../lib/db";
import { checksumBlob, dependencyIdsForOperation, flushOutbox, getOrCreateDeviceId } from "../lib/sync";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../lib/offlineTypes";
import type { OfflineMediaRecord, SyncOperation } from "../lib/offlineTypes";

interface Props {
  openingId: string;
  relatedEntityType?: "opening" | "frame" | "door_leaf" | "hardware_component";
  relatedEntityId?: string;
  onQueued: () => void; // fires the instant a photo/video is saved locally, not once it's uploaded
}

// Matches the API's ALLOWED_CONTENT_TYPES in src/services/storage.ts — kept
// in sync manually since this is a separate app; if that list changes there,
// this needs to change too, or the upload will reach the server and get a
// 400 back after already being queued locally (still safe, just a wasted
// round trip surfaced as an error later rather than caught at capture time).
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB, matches the server-side constant
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function PhotoCapture({ openingId, relatedEntityType = "opening", relatedEntityId, onQueued }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputSuffix = `${openingId}-${relatedEntityType}-${relatedEntityId ?? openingId}`.replace(/[^a-zA-Z0-9_-]/g, "-");

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

    const isVideo = file.type.startsWith("video/");
    if (isVideo && file.size > MAX_VIDEO_BYTES) {
      setError(`That video is too large (${Math.round(file.size / 1024 / 1024)}MB) — 100MB max. Try a shorter clip.`);
      return;
    }
    if (!isVideo && file.size > MAX_IMAGE_BYTES) {
      setError(`That photograph is too large (${Math.round(file.size / 1024 / 1024)}MB) — 25MB max.`);
      return;
    }

    setSaving(true);
    try {
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
      const checksum = await checksumBlob(file);
      const targetId = relatedEntityId ?? openingId;
      const dependencies = dependencyIdsForOperation(await getAllSyncOperations(), "photo", openingId, {
        target_type: relatedEntityType, target_id: targetId,
      });
      const media: OfflineMediaRecord = {
        photoId, openingId, organizationId: auth.organizationId,
        targetType: relatedEntityType, targetId, capturedAtDevice: now,
        capturedByUserId: auth.userId, capturedByDeviceId: deviceId,
        originalFilename: file.name, generatedCaptureName: `${photoId}.${file.type.split("/")[1] || "bin"}`,
        contentType: file.type, byteSize: file.size, sha256Checksum: checksum, blob: file,
        latitude: location.latitude, longitude: location.longitude,
        localBlobState: "retained", uploadState: "queued", provenanceState: "original",
        reviewState: "pending", createdAtLocal: now, updatedAtLocal: now,
      };
      const operation: SyncOperation = {
        operationId, operationType: "confirm_media", entityType: "photo", entityId: photoId,
        openingId, organizationId: auth.organizationId, actorUserId: auth.userId, deviceId,
        baseServerRevision: null, payload: { target_type: relatedEntityType, target_id: targetId,
          original_filename: file.name, content_type: file.type, byte_size: file.size, sha256_checksum: checksum,
          latitude: location.latitude, longitude: location.longitude },
        payloadHash: checksum, dependencyOperationIds: dependencies, createdAtLocal: now,
        state: dependencies.length ? "blocked_dependency" : "queued", attemptCount: 0,
        schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "offline-protocol-1", protocolVersion: SYNC_PROTOCOL_VERSION,
      };
      await saveMediaAndOperation(media, operation);
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
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}
