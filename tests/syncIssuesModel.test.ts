import { describe, expect, it } from "vitest";
import { syncIssuesForRecords } from "../field-app/src/lib/syncIssuesModel";
import type { OfflineMediaRecord, SyncConflict, SyncOperation } from "../field-app/src/lib/offlineTypes";

const baseOperation = {
  operationId: "11111111-1111-4111-8111-111111111111", operationType: "create", entityType: "component",
  entityId: "22222222-2222-4222-8222-222222222222", openingId: "33333333-3333-4333-8333-333333333333",
  organizationId: "44444444-4444-4444-8444-444444444444", actorUserId: "55555555-5555-4555-8555-555555555555",
  deviceId: "66666666-6666-4666-8666-666666666666", baseServerRevision: null, payload: {}, payloadHash: "sha256:x",
  dependencyOperationIds: [], createdAtLocal: "2026-09-18T12:00:00.000Z", state: "queued", attemptCount: 0,
  schemaVersion: 3, appVersion: "phase-1", protocolVersion: 1,
} satisfies SyncOperation;

describe("sync issue presentation", () => {
  it("surfaces conflicts, authorization blocks, and abandoned leases but not active dispatches", () => {
    const conflictOperation = { ...baseOperation, state: "conflict" as const };
    const authOperation = { ...baseOperation, operationId: "77777777-7777-4777-8777-777777777777",
      state: "auth_required" as const, createdAtLocal: "2026-09-18T12:01:00.000Z" };
    const abandoned = { ...baseOperation, operationId: "88888888-8888-4888-8888-888888888888",
      state: "in_flight" as const, createdAtLocal: "2026-09-18T12:00:30.000Z",
      dispatchLeaseExpiresAt: "2026-09-18T12:01:00.000Z" };
    const active = { ...baseOperation, operationId: "99999999-9999-4999-8999-999999999999",
      state: "verifying" as const, dispatchLeaseExpiresAt: "2026-09-18T12:10:00.000Z" };
    const conflict: SyncConflict = { conflictId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operationId: conflictOperation.operationId, entityId: conflictOperation.entityId,
      openingId: conflictOperation.openingId, organizationId: conflictOperation.organizationId,
      affectedFields: ["name"], baseValues: {}, localValues: {}, serverValues: {},
      detectedAt: "2026-09-18T12:02:00.000Z", resolutionState: "open" };
    const issues = syncIssuesForRecords([active, abandoned, authOperation, conflictOperation], [conflict], [],
      Date.parse("2026-09-18T12:02:00.000Z"));
    expect(issues.map((issue) => issue.id)).toEqual([
      conflictOperation.operationId, abandoned.operationId, authOperation.operationId,
    ]);
    expect(issues[0].conflict).toBe(true);
  });

  it("offers recovery for legacy interrupted work without lease metadata", () => {
    const interrupted = { ...baseOperation, state: "in_flight" as const,
      lastAttemptAt: "2026-09-18T11:59:00.000Z" };
    expect(syncIssuesForRecords([interrupted], [], [], Date.parse("2026-09-18T12:02:00.000Z")))
      .toEqual([expect.objectContaining({ id: interrupted.operationId, kind: "operation", status: "in_flight" })]);
  });

  it("keeps an orphaned failed media record visible for review", () => {
    const media = { photoId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", openingId: baseOperation.openingId,
      organizationId: baseOperation.organizationId, targetType: "opening", targetId: baseOperation.openingId,
      capturedAtDevice: baseOperation.createdAtLocal, capturedByUserId: baseOperation.actorUserId,
      capturedByDeviceId: baseOperation.deviceId, originalFilename: "capture.jpg", generatedCaptureName: "capture.jpg",
      contentType: "image/jpeg", byteSize: 3, sha256Checksum: "a".repeat(64), blob: new Blob(["abc"]),
      localBlobState: "retained", uploadState: "permanent_failure", provenanceState: "original",
      reviewState: "pending", createdAtLocal: baseOperation.createdAtLocal, updatedAtLocal: baseOperation.createdAtLocal,
    } satisfies OfflineMediaRecord;
    expect(syncIssuesForRecords([], [], [media])).toEqual([
      expect.objectContaining({ id: media.photoId, kind: "orphaned_media", status: "orphaned_media" }),
    ]);
  });
});
