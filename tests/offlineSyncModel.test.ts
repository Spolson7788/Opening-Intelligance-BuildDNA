import { describe, expect, it } from "vitest";
import {
  readyOperations,
  retryDelayMs,
  technicianStatusForStates,
  validateOfflineEntity,
  validateSyncOperation,
} from "../field-app/src/lib/offlineSyncModel";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { OfflineEntityEnvelope, SyncOperation } from "../field-app/src/lib/offlineTypes";

const ids = {
  operation: "11111111-1111-4111-8111-111111111111",
  entity: "22222222-2222-4222-8222-222222222222",
  opening: "33333333-3333-4333-8333-333333333333",
  organization: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
  device: "66666666-6666-4666-8666-666666666666",
};

function operation(overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    operationId: ids.operation,
    operationType: "create",
    entityType: "component",
    entityId: ids.entity,
    openingId: ids.opening,
    organizationId: ids.organization,
    actorUserId: ids.user,
    deviceId: ids.device,
    baseServerRevision: null,
    payload: { componentType: "hinge" },
    payloadHash: "sha256:abc",
    dependencyOperationIds: [],
    createdAtLocal: "2026-09-18T12:00:00.000Z",
    state: "queued",
    attemptCount: 0,
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    appVersion: "phase-1",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    ...overrides,
  };
}

describe("offline synchronization contract", () => {
  it("maps internal states to the six technician-facing statuses with safe precedence", () => {
    expect(technicianStatusForStates(["verified"])).toBe("synced");
    expect(technicianStatusForStates(["local_committed"])).toBe("saved_locally");
    expect(technicianStatusForStates(["queued"])).toBe("waiting_to_sync");
    expect(technicianStatusForStates(["in_flight", "queued"])).toBe("syncing");
    expect(technicianStatusForStates(["auth_required", "in_flight"])).toBe("needs_attention");
    expect(technicianStatusForStates(["conflict", "auth_required"])).toBe("conflict_requires_review");
  });

  it("does not release a child operation until every dependency is verified", () => {
    const parent = operation();
    const child = operation({
      operationId: "77777777-7777-4777-8777-777777777777",
      entityId: "88888888-8888-4888-8888-888888888888",
      dependencyOperationIds: [parent.operationId],
      createdAtLocal: "2026-09-18T12:01:00.000Z",
    });
    expect(readyOperations([parent, child], new Set(), "2026-09-18T12:02:00.000Z")).toEqual([parent]);
    expect(readyOperations([child], new Set([parent.operationId]), "2026-09-18T12:02:00.000Z")).toEqual([child]);
  });

  it("honors retry time and preserves deterministic creation order", () => {
    const later = operation({ operationId: "77777777-7777-4777-8777-777777777777", entityId: "88888888-8888-4888-8888-888888888888", createdAtLocal: "2026-09-18T12:02:00.000Z" });
    const delayed = operation({ state: "retry_wait", nextAttemptAt: "2026-09-18T12:05:00.000Z" });
    expect(readyOperations([later, delayed], new Set(), "2026-09-18T12:03:00.000Z")).toEqual([later]);
  });

  it("rejects malformed identity and dependency envelopes", () => {
    expect(validateSyncOperation(operation({ operationId: "bad", dependencyOperationIds: ["bad", "bad"] }))).toEqual(
      expect.arrayContaining(["invalid_operation_id", "duplicate_dependency"]),
    );
  });

  it("validates the entity key and permanent identities", () => {
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
      payload: {},
    };
    expect(validateOfflineEntity(entity)).toEqual([]);
    expect(validateOfflineEntity({ ...entity, key: "hinge" })).toContain("invalid_entity_key");
  });

  it("uses bounded exponential backoff with bounded jitter", () => {
    expect(retryDelayMs(0, 0.5)).toBe(2_000);
    expect(retryDelayMs(1, 0.5)).toBe(4_000);
    expect(retryDelayMs(99, 0.5)).toBe(300_000);
    expect(retryDelayMs(0, -10)).toBe(1_500);
    expect(retryDelayMs(0, 10)).toBe(2_500);
  });
});
