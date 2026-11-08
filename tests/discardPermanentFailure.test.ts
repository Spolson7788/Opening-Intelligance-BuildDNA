import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeFieldAppDb, discardPermanentFailure, getSyncOperationsForPrincipal, putSyncOperation, saveAuth, saveEntityAndOperation } from "../field-app/src/lib/db";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { OfflineEntityEnvelope, SyncOperation } from "../field-app/src/lib/offlineTypes";

const ids = {
  user: "55555555-5555-4555-8555-555555555555",
  organization: "44444444-4444-4444-8444-444444444444",
  opening: "33333333-3333-4333-8333-333333333333",
  device: "66666666-6666-4666-8666-666666666666",
  entity: "11111111-1111-4111-8111-111111111111",
  operation: "22222222-2222-4222-8222-222222222222",
};

function operation(state: SyncOperation["state"]): SyncOperation {
  return {
    operationId: ids.operation, operationType: "create", entityType: "inspection_event", entityId: ids.entity,
    openingId: ids.opening, organizationId: ids.organization, actorUserId: ids.user, deviceId: ids.device,
    baseServerRevision: null, payload: { inspection_type: "fire_door_nfpa80" }, payloadHash: "a".repeat(64),
    dependencyOperationIds: [], createdAtLocal: "2026-11-08T18:05:00.000Z", state, attemptCount: 1,
    lastErrorCode: state === "permanent_failure" ? "internal_error" : undefined,
    schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", protocolVersion: SYNC_PROTOCOL_VERSION,
  };
}

function entity(): OfflineEntityEnvelope {
  const now = "2026-11-08T18:05:00.000Z";
  return {
    key: entityKey("inspection_event", ids.entity), id: ids.entity, entityType: "inspection_event",
    organizationId: ids.organization, openingId: ids.opening, createdByUserId: ids.user, createdByDeviceId: ids.device,
    createdAtLocal: now, updatedAtLocal: now, serverRevision: null, baseSnapshotHash: null,
    schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", syncState: "permanent_failure", retryCount: 1,
    payload: { inspection_type: "fire_door_nfpa80" },
  };
}

beforeEach(async () => {
  await saveAuth({ token: "t", userId: ids.user, organizationId: ids.organization, role: "technician" });
});
afterEach(async () => { await closeFieldAppDb(); });

it("discards a permanently failed inspection and leaves a queued one in place", async () => {
  await saveEntityAndOperation(entity(), operation("queued"));
  await expect(discardPermanentFailure(ids.operation)).rejects.toThrow("operation_not_permanent_failure");
  expect(await getSyncOperationsForPrincipal(ids.user, ids.organization)).toHaveLength(1);

  await putSyncOperation(operation("permanent_failure"));
  await discardPermanentFailure(ids.operation);
  expect(await getSyncOperationsForPrincipal(ids.user, ids.organization)).toHaveLength(0);

  await saveAuth({ token: "t", userId: ids.user, organizationId: ids.organization, role: "technician" });
  await putSyncOperation({ ...operation("retry_wait"), lastErrorCode: "photo_unreadable" });
  await discardPermanentFailure(ids.operation);
  expect(await getSyncOperationsForPrincipal(ids.user, ids.organization)).toHaveLength(0);

  await saveAuth({ token: "t", userId: "99999999-9999-4999-8999-999999999999", organizationId: ids.organization, role: "technician" });
  await putSyncOperation(operation("permanent_failure"));
  await expect(discardPermanentFailure(ids.operation)).rejects.toThrow("operation_principal_mismatch");
});
