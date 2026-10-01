// Upload limits for field media. These MUST equal the API's limits in
// src/services/storage.ts (MAX_IMAGE_BYTES / MAX_VIDEO_BYTES); a test
// (tests/photoSizeRecovery.test.ts) fails if they drift apart. The server is
// authoritative: the reservation route refuses larger media with 413
// media_too_large, so a client allowing more would queue uploads that can
// never succeed.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export function maximumMediaBytes(contentType: string): number {
  return contentType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

export const MEDIA_TOO_LARGE = "media_too_large";

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
