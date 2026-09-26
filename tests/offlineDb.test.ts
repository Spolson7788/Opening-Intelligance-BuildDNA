import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFieldAppDb,
  claimSyncOperation,
  getDb,
  getOfflineEntitiesForOpening,
  getSyncOperationsForOpening,
  getSyncOperationsForPrincipal,
  putSyncReceipt,
  getOfflineMedia,
  removeVerifiedLocalOriginal,
  recoverOrphanedMediaOperation,
  reconcileRecoveredMediaOperationId,
  saveEntityAndOperation,
  saveMediaAndOperation,
  saveAuth,
  putSyncOperation,
  retrySyncOperationAfterReview,
} from "../field-app/src/lib/db";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { OfflineEntityEnvelope, OfflineMediaRecord, SyncOperation, SyncReceipt } from "../field-app/src/lib/offlineTypes";

const ids = {
  operation: "11111111-1111-4111-8111-111111111111",
  entity: "22222222-2222-4222-8222-222222222222",
  opening: "33333333-3333-4333-8333-333333333333",
  organization: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
  device: "66666666-6666-4666-8666-666666666666",
};

function record(): { entity: OfflineEntityEnvelope; operation: SyncOperation } {
  const entity: OfflineEntityEnvelope = {
    key: entityKey("component", ids.entity),
    id: ids.entity,
    entityType: "component",
    organizationId: ids.organization,
    openingId: ids.opening,
    createdByUserId: ids.user,
    createdByDeviceId: ids.device,
    createdAtLocal: "2026-09-18T12:00:00.000Z",
    updatedAtLocal: "2026-09-18T12:00:00.000Z",
    serverRevision: null,
    baseSnapshotHash: null,
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    appVersion: "phase-1",
    syncState: "local_committed",
    retryCount: 0,
    payload: { componentType: "hinge", positionLabel: "top" },
  };
  const operation: SyncOperation = {
    operationId: ids.operation,
    operationType: "create",
    entityType: "component",
    entityId: ids.entity,
    openingId: ids.opening,
    organizationId: ids.organization,
    actorUserId: ids.user,
    deviceId: ids.device,
    baseServerRevision: null,
    payload: entity.payload,
    payloadHash: "sha256:abc",
    dependencyOperationIds: [],
    createdAtLocal: entity.createdAtLocal,
    state: "queued",
    attemptCount: 0,
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    appVersion: "phase-1",
    protocolVersion: SYNC_PROTOCOL_VERSION,
  };
  return { entity, operation };
}

afterEach(async () => {
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe("versioned offline database", () => {
  it("creates the phase 1 stores without removing legacy stores", async () => {
    const db = await getDb();
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining([
      "openings", "outbox", "photoOutbox", "auth",
      "entities", "operations", "media", "syncReceipts", "conflicts", "openingSnapshots", "settings",
    ]));
  });

  it("commits an entity and its operation atomically", async () => {
    const { entity, operation } = record();
    await saveEntityAndOperation(entity, operation);
    expect(await getOfflineEntitiesForOpening(ids.opening)).toEqual([entity]);
    expect(await getSyncOperationsForOpening(ids.opening)).toEqual([operation]);
  });

  it("rejects an identity mismatch before either record is written", async () => {
    const { entity, operation } = record();
    await expect(saveEntityAndOperation(entity, { ...operation, entityId: ids.opening })).rejects.toThrow(
      "entity_operation_identity_mismatch",
    );
    expect(await getOfflineEntitiesForOpening(ids.opening)).toEqual([]);
    expect(await getSyncOperationsForOpening(ids.opening)).toEqual([]);
  });

  it("marks an operation verified only when the receipt identities match", async () => {
    const { entity, operation } = record();
    await saveEntityAndOperation(entity, operation);
    const receipt: SyncReceipt = {
      operationId: operation.operationId,
      entityId: operation.entityId,
      entityType: operation.entityType,
      openingId: operation.openingId,
      organizationId: operation.organizationId,
      serverRevision: 1,
      normalizedRecordHash: "sha256:def",
      serverAcceptedAt: "2026-09-18T12:01:00.000Z",
      verifiedAt: "2026-09-18T12:01:01.000Z",
    };
    await putSyncReceipt(receipt);
    const [saved] = await getSyncOperationsForOpening(ids.opening);
    expect(saved.state).toBe("verified");
    const [savedEntity] = await getOfflineEntitiesForOpening(ids.opening);
    expect(savedEntity.syncState).toBe("verified");
    expect(savedEntity.serverRevision).toBe(1);
  });

  it("retains a local original until both media proofs are recorded", async () => {
    const photoId = ids.entity;
    const media: OfflineMediaRecord = {
      photoId, openingId: ids.opening, organizationId: ids.organization, targetType: "opening", targetId: ids.opening,
      capturedAtDevice: "2026-09-18T12:00:00.000Z", capturedByUserId: ids.user, capturedByDeviceId: ids.device,
      originalFilename: "capture.jpg", generatedCaptureName: "capture.jpg", contentType: "image/jpeg", byteSize: 3,
      sha256Checksum: "a".repeat(64), blob: new Blob(["abc"], { type: "image/jpeg" }), localBlobState: "retained",
      uploadState: "queued", provenanceState: "original", reviewState: "pending",
      createdAtLocal: "2026-09-18T12:00:00.000Z", updatedAtLocal: "2026-09-18T12:00:00.000Z",
    };
    const operation: SyncOperation = { ...record().operation, entityId: photoId, entityType: "photo", operationType: "confirm_media" };
    await saveMediaAndOperation(media, operation);
    const receipt: SyncReceipt = { operationId: ids.operation, entityId: photoId, entityType: "photo",
      openingId: ids.opening, organizationId: ids.organization, serverRevision: 1, normalizedRecordHash: "b".repeat(64),
      serverAcceptedAt: "2026-09-18T12:01:00.000Z", verifiedAt: "2026-09-18T12:01:01.000Z",
      mediaObjectVerified: true, authorizedRetrievalVerified: false };
    await expect(putSyncReceipt(receipt)).rejects.toThrow("receipt_media_proof_incomplete");
    await expect(removeVerifiedLocalOriginal(photoId)).rejects.toThrow("local_original_not_verified_for_cleanup");
    await putSyncReceipt({ ...receipt, authorizedRetrievalVerified: true });
    expect((await getOfflineMedia(photoId))?.localBlobState).toBe("verified_cleanup_allowed");
    await removeVerifiedLocalOriginal(photoId);
    expect(await getOfflineMedia(photoId)).toBeUndefined();
  });

  it("claims work only for the current principal and preserves another account's queue", async () => {
    const { entity, operation } = record();
    await saveEntityAndOperation(entity, operation);
    const otherUser = "77777777-7777-4777-8777-777777777777";
    await saveAuth({ token: "other-token", userId: otherUser, organizationId: ids.organization, role: "technician" });
    expect(await claimSyncOperation({ operationId: operation.operationId, userId: ids.user,
      organizationId: ids.organization, leaseId: "tab-a", nowIso: "2026-09-18T12:01:00.000Z", leaseDurationMs: 60_000 }))
      .toBeUndefined();
    expect(await getSyncOperationsForPrincipal(ids.user, ids.organization)).toEqual([operation]);
    await saveAuth({ token: "owner-token", userId: ids.user, organizationId: ids.organization, role: "technician" });
    expect((await claimSyncOperation({ operationId: operation.operationId, userId: ids.user,
      organizationId: ids.organization, leaseId: "tab-a", nowIso: "2026-09-18T12:01:00.000Z", leaseDurationMs: 60_000 }))
      ?.dispatchLeaseId).toBe("tab-a");
  });

  it("prevents duplicate live claims and recovers an expired lease", async () => {
    const { entity, operation } = record();
    await saveEntityAndOperation(entity, operation);
    await saveAuth({ token: "owner-token", userId: ids.user, organizationId: ids.organization, role: "technician" });
    const first = await claimSyncOperation({ operationId: operation.operationId, userId: ids.user,
      organizationId: ids.organization, leaseId: "tab-a", nowIso: "2026-09-18T12:01:00.000Z", leaseDurationMs: 60_000 });
    expect(first).toBeDefined();
    expect(await claimSyncOperation({ operationId: operation.operationId, userId: ids.user,
      organizationId: ids.organization, leaseId: "tab-b", nowIso: "2026-09-18T12:01:30.000Z", leaseDurationMs: 60_000 }))
      .toBeUndefined();
    await putSyncOperation({ ...first!, dispatchLeaseExpiresAt: "2026-09-18T12:01:31.000Z" });
    expect((await claimSyncOperation({ operationId: operation.operationId, userId: ids.user,
      organizationId: ids.organization, leaseId: "tab-b", nowIso: "2026-09-18T12:01:32.000Z", leaseDurationMs: 60_000 }))
      ?.dispatchLeaseId).toBe("tab-b");
  });

  it("requires the owning principal before retrying authorization-blocked work", async () => {
    const { entity, operation } = record();
    await saveEntityAndOperation(entity, { ...operation, state: "auth_required" });
    await saveAuth({ token: "other-token", userId: "77777777-7777-4777-8777-777777777777",
      organizationId: ids.organization, role: "technician" });
    await expect(retrySyncOperationAfterReview(operation.operationId)).rejects.toThrow("operation_principal_mismatch");
    await saveAuth({ token: "owner-token", userId: ids.user, organizationId: ids.organization, role: "technician" });
    await retrySyncOperationAfterReview(operation.operationId);
    expect((await getSyncOperationsForOpening(ids.opening))[0].state).toBe("queued");
  });

  it("lets the owning principal recover an expired or legacy interrupted operation", async () => {
    const { entity, operation } = record();
    await saveEntityAndOperation(entity, { ...operation, state: "in_flight",
      lastAttemptAt: "2026-09-18T12:00:00.000Z" });
    await saveAuth({ token: "owner-token", userId: ids.user, organizationId: ids.organization, role: "technician" });
    await retrySyncOperationAfterReview(operation.operationId, false, "2026-09-18T12:03:00.000Z");
    expect((await getSyncOperationsForOpening(ids.opening))[0]).toMatchObject({ state: "queued" });
  });

  it("reconstructs an orphaned photo operation without deleting or replacing the original blob", async () => {
    const media: OfflineMediaRecord = {
      photoId: ids.entity, openingId: ids.opening, organizationId: ids.organization, targetType: "opening",
      targetId: ids.opening, capturedAtDevice: "2026-09-18T12:00:00.000Z", capturedByUserId: ids.user,
      capturedByDeviceId: ids.device, originalFilename: "capture.jpg", generatedCaptureName: "capture.jpg",
      contentType: "image/jpeg", byteSize: 3, sha256Checksum: "a".repeat(64),
      blob: new Blob(["abc"], { type: "image/jpeg" }), localBlobState: "retained", uploadState: "queued",
      provenanceState: "original", reviewState: "pending", createdAtLocal: "2026-09-18T12:00:00.000Z",
      updatedAtLocal: "2026-09-18T12:00:00.000Z",
    };
    const operation = { ...record().operation, entityId: media.photoId, entityType: "photo" as const,
      operationType: "confirm_media" as const };
    await saveMediaAndOperation(media, operation);
    const db = await getDb();
    await db.delete("operations", operation.operationId);
    await saveAuth({ token: "owner-token", userId: ids.user, organizationId: ids.organization, role: "technician" });
    const recovered = await recoverOrphanedMediaOperation(media.photoId);
    expect(recovered).toMatchObject({ operationId: operation.operationId, entityId: media.photoId, state: "queued" });
    const preserved = await getOfflineMedia(media.photoId);
    expect(await preserved!.blob.text()).toBe("abc");
    expect(preserved).toMatchObject({ localBlobState: "retained", operationId: operation.operationId });
  });

  it("reconciles a true legacy orphan fallback with the server reservation operation ID", async () => {
    const media: OfflineMediaRecord = {
      photoId: ids.entity, openingId: ids.opening, organizationId: ids.organization, targetType: "opening",
      targetId: ids.opening, capturedAtDevice: "2026-09-18T12:00:00.000Z", capturedByUserId: ids.user,
      capturedByDeviceId: ids.device, originalFilename: "legacy.jpg", generatedCaptureName: "legacy.jpg",
      contentType: "image/jpeg", byteSize: 6, sha256Checksum: "c".repeat(64),
      blob: new Blob(["legacy"], { type: "image/jpeg" }), localBlobState: "retained", uploadState: "queued",
      provenanceState: "original", reviewState: "pending", createdAtLocal: "2026-09-18T12:00:00.000Z",
      updatedAtLocal: "2026-09-18T12:00:00.000Z",
    };
    const db = await getDb();
    await db.put("media", media); // genuine pre-operationId media record
    await saveAuth({ token: "owner-token", userId: ids.user, organizationId: ids.organization, role: "technician" });
    const fallback = await recoverOrphanedMediaOperation(media.photoId);
    expect(fallback.operationId).toBe(media.photoId);
    expect(fallback.payload).toMatchObject({ legacy_identity_recovery: true });

    const serverReservationOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reconciled = await reconcileRecoveredMediaOperationId(fallback.operationId, serverReservationOperationId);
    expect(reconciled?.operationId).toBe(serverReservationOperationId);
    expect((await getOfflineMedia(media.photoId))?.operationId).toBe(serverReservationOperationId);
    expect(await (await getOfflineMedia(media.photoId))!.blob.text()).toBe("legacy");
    expect((await getSyncOperationsForOpening(ids.opening)).map((item) => item.operationId))
      .toEqual([serverReservationOperationId]);
  });
});

describe('opening cache principal isolation',()=>{
 it('does not expose another account or an unowned legacy cache entry',async()=>{
  const {cacheOpening,getCachedOpening,clearAuth}=await import('../field-app/src/lib/db');
  await saveAuth({token:'a',userId:'a',organizationId:'company-a',role:'technician'});
  await cacheOpening({id:'cache-test',name:'Private opening'});
  expect(await getCachedOpening('cache-test')).toBeDefined();
  await saveAuth({token:'b',userId:'b',organizationId:'company-b',role:'technician'});
  expect(await getCachedOpening('cache-test')).toBeUndefined();
  await (await getDb()).put('openings',{id:'legacy-test',name:'unowned legacy'});
  expect(await getCachedOpening('legacy-test')).toBeUndefined();
  await clearAuth();expect(await getCachedOpening('cache-test')).toBeUndefined();
 });
 it('refuses caching a response for a principal who signed out during the request',async()=>{
  const {cacheOpening,getCachedOpening}=await import('../field-app/src/lib/db');
  await saveAuth({token:'b',userId:'b',organizationId:'company-b',role:'technician'});
  await cacheOpening({id:'late-a'}, {userId:'a',organizationId:'company-a'});
  expect(await getCachedOpening('late-a')).toBeUndefined();
 });
});
