import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Network boundary for the Field App photo protocol. Each call is recorded so
// tests can prove a size-refused photograph is not retried.
const net = vi.hoisted(() => ({ reserve: [] as any[], put: [] as any[], confirm: [] as any[], reserveStatus: 201 }));

vi.mock("../field-app/src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field-app/src/lib/api")>();
  return {
    ...actual,
    reserveOfflinePhoto: async (input: any) => {
      net.reserve.push(input);
      if (net.reserveStatus === 413) throw new actual.ApiError(413, "media_too_large");
      return { photo_id: input.photo_id, client_operation_id: input.client_operation_id, status: "reserved",
        upload_url: "https://storage.invalid/private-upload/x" };
    },
    uploadPrivatePhoto: async (...args: any[]) => { net.put.push(args); },
    confirmOfflinePhoto: async (input: any) => {
      net.confirm.push(input);
      return { operation_id: input.client_operation_id, entity_id: input.photo_id, entity_type: "photo",
        opening_id: ids.opening, organization_id: ids.organization, resulting_server_revision: 1,
        normalized_record_hash: "c".repeat(64), server_accepted_at: "2026-10-01T12:00:00.000Z",
        verified_at: "2026-10-01T12:00:01.000Z", media_object_verified: true, authorized_retrieval_verified: true,
        status: "accepted" };
    },
  };
});

import { closeFieldAppDb, getOfflineMedia, getSyncOperationsForPrincipal, removeRejectedMedia,
  replaceRejectedMediaWithReducedCopy, saveAuth, saveMediaAndOperation } from "../field-app/src/lib/db";
import { flushVersionedOperations, isMediaSizeRejection } from "../field-app/src/lib/sync";
import { ApiError } from "../field-app/src/lib/api";
import { syncIssuesForRecords } from "../field-app/src/lib/syncIssuesModel";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "../field-app/src/lib/mediaLimits";
import { prepareImageForUpload, reducedFilename, REDUCTION_LADDER } from "../field-app/src/lib/photoPreparation";
import type { DecodedImage } from "../field-app/src/lib/photoPreparation";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { OfflineMediaRecord, SyncOperation } from "../field-app/src/lib/offlineTypes";
import * as server from "../src/services/storage";

const ids = {
  opening: "33333333-3333-4333-8333-333333333333",
  organization: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
  other: "77777777-7777-4777-8777-777777777777",
  device: "66666666-6666-4666-8666-666666666666",
  component: "88888888-8888-4888-8888-888888888888",
};
const MB = 1024 * 1024;

function bytes(n: number, type = "image/jpeg") { return new Blob([new Uint8Array(n)], { type }); }

function records(photoId: string, operationId: string, size: number, state: SyncOperation["state"] = "queued",
  lastErrorCode?: string): { media: OfflineMediaRecord; operation: SyncOperation } {
  const now = "2026-10-01T12:00:00.000Z";
  return {
    media: { photoId, openingId: ids.opening, organizationId: ids.organization, targetType: "hardware_component",
      targetId: ids.component, capturedAtDevice: now, capturedByUserId: ids.user, capturedByDeviceId: ids.device,
      originalFilename: "IMG_0001.HEIC", generatedCaptureName: `${photoId}.jpeg`, contentType: "image/jpeg",
      byteSize: size, sha256Checksum: "a".repeat(64), blob: bytes(size), localBlobState: "retained",
      uploadState: state, provenanceState: "original", reviewState: "pending", createdAtLocal: now, updatedAtLocal: now },
    operation: { operationId, operationType: "confirm_media", entityType: "photo", entityId: photoId,
      openingId: ids.opening, organizationId: ids.organization, actorUserId: ids.user, deviceId: ids.device,
      baseServerRevision: null, payload: { target_type: "hardware_component", target_id: ids.component },
      payloadHash: "a".repeat(64), dependencyOperationIds: [], createdAtLocal: now, state, attemptCount: 0,
      lastErrorCode, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", protocolVersion: SYNC_PROTOCOL_VERSION },
  };
}

// Deterministic stand-in for the browser's canvas encoder: output size is
// proportional to pixel count and quality.
function fakeDecoder(width: number, height: number, bytesPerPixelAtFull: number): (blob: Blob) => Promise<DecodedImage> {
  return async () => ({
    width, height,
    async encode(longEdge: number, quality: number) {
      const scale = Math.min(1, longEdge / Math.max(width, height));
      const w = Math.round(width * scale), h = Math.round(height * scale);
      return { blob: bytes(Math.round(w * h * bytesPerPixelAtFull * quality)), width: w, height: h };
    },
    close() {},
  });
}

beforeEach(async () => {
  net.reserve = []; net.put = []; net.confirm = []; net.reserveStatus = 201;
  await saveAuth({ token: "t", userId: ids.user, organizationId: ids.organization, role: "technician" });
});
afterEach(async () => {
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe("one photo size limit for Field App and API", () => {
  it("client limits equal the server limits", () => {
    expect(MAX_IMAGE_BYTES).toBe(server.MAX_IMAGE_BYTES);
    expect(MAX_VIDEO_BYTES).toBe(server.MAX_VIDEO_BYTES);
    expect(server.maximumMediaBytes("image/jpeg")).toBe(MAX_IMAGE_BYTES);
  });
});

describe("ordinary phone photographs are prepared to fit the limit", () => {
  it("keeps a photograph at or under the limit byte-for-byte", async () => {
    const exact = bytes(MAX_IMAGE_BYTES);
    const prepared = await prepareImageForUpload(exact, MAX_IMAGE_BYTES, () => { throw new Error("must not decode"); });
    expect(prepared).toMatchObject({ blob: exact, reduced: false, withinLimit: true });
  });

  it("reduces a 12 MP, 4.5 MB phone photograph to a JPEG under 2 MB without enlarging it", async () => {
    const prepared = await prepareImageForUpload(bytes(4.5 * MB), MAX_IMAGE_BYTES, fakeDecoder(4032, 3024, 0.3));
    expect(prepared.withinLimit).toBe(true);
    expect(prepared.reduced).toBe(true);
    expect(prepared.contentType).toBe("image/jpeg");
    expect(prepared.blob.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(Math.max(prepared.width!, prepared.height!)).toBeLessThanOrEqual(4032);
    expect(prepared.sourceBytes).toBe(4.5 * MB);
  });

  it("keeps the original and reports it when the format cannot be decoded (HEIC in Chromium)", async () => {
    const original = bytes(3 * MB, "image/heic");
    const prepared = await prepareImageForUpload(original, MAX_IMAGE_BYTES, async () => { throw new Error("unsupported"); });
    expect(prepared).toMatchObject({ blob: original, withinLimit: false, reduced: false, reason: "decode_failed" });
  });

  it("keeps the original when no ladder step fits", async () => {
    const original = bytes(9 * MB);
    const prepared = await prepareImageForUpload(original, MAX_IMAGE_BYTES, fakeDecoder(8000, 6000, 40));
    expect(prepared).toMatchObject({ blob: original, withinLimit: false, reason: "cannot_reduce_below_limit" });
    expect(REDUCTION_LADDER.length).toBeGreaterThan(3);
  });

  it("names a reduced copy as JPEG", () => {
    expect(reducedFilename("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
    expect(reducedFilename("photo")).toBe("photo.jpg");
  });
});

describe("a size-refused photograph stops, stays on the device and is surfaced", () => {
  it("classifies 413, media_too_large and an S3 413 as size refusals only", () => {
    expect(isMediaSizeRejection(new ApiError(413, "media_too_large"))).toBe(true);
    expect(isMediaSizeRejection(new Error("upload_failed_413"))).toBe(true);
    expect(isMediaSizeRejection(new ApiError(409, "idempotency_key_reused"))).toBe(false);
    expect(isMediaSizeRejection(new Error("upload_failed_503"))).toBe(false);
  });

  it("an oversized item queued by the previous app version is not sent and is not retried", async () => {
    const photo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", op = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const { media, operation } = records(photo, op, 3 * MB, "retry_wait", "upload_failed_413");
    await saveMediaAndOperation(media, operation);
    await flushVersionedOperations();
    await flushVersionedOperations();
    expect(net.reserve).toHaveLength(0);
    const [stored] = await getSyncOperationsForPrincipal(ids.user, ids.organization);
    expect(stored).toMatchObject({ state: "permanent_failure", lastErrorCode: "media_too_large", attemptCount: 1 });
    expect(stored.nextAttemptAt).toBeUndefined();
    expect((await getOfflineMedia(photo))?.blob.size).toBe(3 * MB);
  });

  it("a server 413 becomes a final, reviewable state rather than an endless retry", async () => {
    const photo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", op = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const { media, operation } = records(photo, op, 1 * MB);
    await saveMediaAndOperation(media, operation);
    net.reserveStatus = 413;
    await flushVersionedOperations();
    await flushVersionedOperations();
    expect(net.reserve).toHaveLength(1);
    const operations = await getSyncOperationsForPrincipal(ids.user, ids.organization);
    expect(operations[0]).toMatchObject({ state: "permanent_failure", lastErrorCode: "media_too_large" });
    const issues = syncIssuesForRecords(operations, [], [(await getOfflineMedia(photo))!]);
    expect(issues).toEqual([expect.objectContaining({ kind: "rejected_media", photoId: photo, mediaBytes: 1 * MB,
      status: "rejected_too_large", label: "hardware component photograph" })]);
  });

  it("does not stall other queued work behind a size refusal", async () => {
    const big = records("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", 3 * MB);
    const small = records("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", 500_000);
    small.operation.createdAtLocal = "2026-10-01T12:00:01.000Z";
    await saveMediaAndOperation(big.media, big.operation);
    await saveMediaAndOperation(small.media, small.operation);
    await flushVersionedOperations();
    expect(net.confirm.map((c) => c.photo_id)).toEqual([small.media.photoId]);
  });
});

describe("recovery actions", () => {
  it("Reduce size and upload replaces the refused item with one derived copy that uploads once", async () => {
    const photo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", op = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
    const { media, operation } = records(photo, op, 3 * MB, "permanent_failure", "media_too_large");
    await saveMediaAndOperation(media, operation);
    const reducedBlob = bytes(1.2 * MB);
    const result = await replaceRejectedMediaWithReducedCopy(photo, { blob: reducedBlob, contentType: "image/jpeg",
      byteSize: reducedBlob.size, sha256Checksum: "d".repeat(64), filename: "IMG_0001.jpg", widthPixels: 2560, heightPixels: 1920 });
    expect(await getOfflineMedia(photo)).toBeUndefined();
    const derived = await getOfflineMedia(result.photoId);
    expect(derived).toMatchObject({ provenanceState: "derived", derivedFromPhotoId: photo, byteSize: reducedBlob.size,
      targetType: "hardware_component", targetId: ids.component, sha256Checksum: "d".repeat(64) });
    await flushVersionedOperations();
    await flushVersionedOperations();
    expect(net.reserve).toHaveLength(1);
    expect(net.reserve[0]).toMatchObject({ photo_id: result.photoId, client_operation_id: result.operationId,
      byte_size: reducedBlob.size, target_type: "hardware_component", target_id: ids.component });
    expect(net.confirm).toHaveLength(1);
  });

  it("Remove from this device is limited to size-refused items of the signed-in technician", async () => {
    const queued = records("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6", 100);
    await saveMediaAndOperation(queued.media, queued.operation);
    await expect(removeRejectedMedia(queued.media.photoId)).rejects.toThrow("media_not_rejected_for_size");

    const refused = records("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7", 3 * MB,
      "permanent_failure", "media_too_large");
    await saveMediaAndOperation(refused.media, refused.operation);
    await saveAuth({ token: "t2", userId: ids.other, organizationId: ids.organization, role: "technician" });
    await expect(removeRejectedMedia(refused.media.photoId)).rejects.toThrow("media_principal_mismatch");
    await expect(replaceRejectedMediaWithReducedCopy(refused.media.photoId, { blob: bytes(10), contentType: "image/jpeg",
      byteSize: 10, sha256Checksum: "e".repeat(64), filename: "x.jpg" })).rejects.toThrow("media_principal_mismatch");
    expect(await getOfflineMedia(refused.media.photoId)).toBeDefined();

    await saveAuth({ token: "t", userId: ids.user, organizationId: ids.organization, role: "technician" });
    await removeRejectedMedia(refused.media.photoId);
    expect(await getOfflineMedia(refused.media.photoId)).toBeUndefined();
    expect((await getSyncOperationsForPrincipal(ids.user, ids.organization)).map((o) => o.operationId))
      .toEqual([queued.operation.operationId]);
  });
});
