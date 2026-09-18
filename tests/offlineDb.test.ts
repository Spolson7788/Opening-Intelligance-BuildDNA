import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFieldAppDb,
  getDb,
  getOfflineEntitiesForOpening,
  getSyncOperationsForOpening,
  putSyncReceipt,
  saveEntityAndOperation,
} from "../field-app/src/lib/db";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { OfflineEntityEnvelope, SyncOperation, SyncReceipt } from "../field-app/src/lib/offlineTypes";

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
});
