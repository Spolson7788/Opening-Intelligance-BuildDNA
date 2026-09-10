import { useState } from "react";
import { enqueuePhotoOutboxItem } from "../lib/db";
import { flushOutbox } from "../lib/sync";

interface Props {
  openingId: string;
  onQueued: () => void; // fires the instant a photo/video is saved locally, not once it's uploaded
}

// Matches the API's ALLOWED_CONTENT_TYPES in src/services/storage.ts — kept
// in sync manually since this is a separate app; if that list changes there,
// this needs to change too, or the upload will reach the server and get a
// 400 back after already being queued locally (still safe, just a wasted
// round trip surfaced as an error later rather than caught at capture time).
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB, matches the server-side constant

export function PhotoCapture({ openingId, onQueued }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    setSaving(true);
    try {
      // Save the blob to IndexedDB immediately — this is the offline-safe step.
      // Upload happens later via the same outbox-flush mechanism as service/
      // inspection events, so this button behaves consistently with the rest
      // of the app regardless of connectivity, and regardless of whether it's
      // a photo or a video.
      const location = await getLocation();
      await enqueuePhotoOutboxItem({
        id: crypto.randomUUID(),
        openingId,
        blob: file,
        contentType: file.type,
        ...location,
      });
      onQueued();
      flushOutbox(); // fire-and-forget: uploads now if online, otherwise sits queued
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
          {saving ? "Saving…" : "+ Add Photo"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFileSelected}
            disabled={saving}
            style={{ display: "none" }}
          />
        </label>
        <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
          {saving ? "Saving…" : "+ Add Video"}
          <input
            type="file"
            accept="video/mp4,video/quicktime"
            capture="environment"
            onChange={onFileSelected}
            disabled={saving}
            style={{ display: "none" }}
          />
        </label>
      </div>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}
