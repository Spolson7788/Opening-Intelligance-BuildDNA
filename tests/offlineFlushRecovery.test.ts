import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiState = vi.hoisted(() => ({
  calls: 0,
  loseFirstResponse: false,
  accepted: new Set<string>(),
  afterAccepted: undefined as undefined | (() => Promise<void>),
  organizationId: "44444444-4444-4444-8444-444444444444",
}));

vi.mock("../field-app/src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field-app/src/lib/api")>();
  return {
    ...actual,
    submitOfflineOperation: async (input: any) => {
      apiState.calls += 1;
      const previouslyAccepted = apiState.accepted.has(input.operation_id);
      apiState.accepted.add(input.operation_id);
      if (apiState.afterAccepted) await apiState.afterAccepted();
      if (apiState.loseFirstResponse && apiState.calls === 1) {
        throw new Error("response_lost_after_server_acceptance");
      }
      return {
        operation_id: input.operation_id, entity_id: input.entity_id, entity_type: input.entity_type,
        opening_id: input.opening_id, organization_id: apiState.organizationId,
        resulting_server_revision: 1, normalized_record_hash: "b".repeat(64),
        server_accepted_at: "2026-09-20T12:00:00.000Z", verified_at: "2026-09-20T12:00:01.000Z",
        status: previouslyAccepted ? "already_applied" : "accepted",
      };
    },
  };
});

import { closeFieldAppDb, getSyncOperationsForOpening, putSyncOperation, saveAuth, saveEntityAndOperation } from "../field-app/src/lib/db";
import { flushVersionedOperations } from "../field-app/src/lib/sync";
import { setSyncReadOnly } from '../field-app/src/lib/syncNavigation';
import { recordFreshSignIn } from '../field-app/src/lib/freshSignIn';
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { OfflineEntityEnvelope, SyncOperation } from "../field-app/src/lib/offlineTypes";

const ids = {
  opening: "33333333-3333-4333-8333-333333333333",
  organization: apiState.organizationId,
  userA: "55555555-5555-4555-8555-555555555555",
  userB: "66666666-6666-4666-8666-666666666666",
  device: "77777777-7777-4777-8777-777777777777",
};

function records(sequence: number): { entity: OfflineEntityEnvelope; operation: SyncOperation } {
  const entityId = `88888888-8888-4888-8888-${String(sequence).padStart(12, "0")}`;
  const operationId = `99999999-9999-4999-8999-${String(sequence).padStart(12, "0")}`;
  const createdAtLocal = `2026-09-20T12:00:0${sequence}.000Z`;
  const payload = { event_date: "2026-09-20", work_performed: `work-${sequence}` };
  return {
    entity: { key: entityKey("service_event", entityId), id: entityId, entityType: "service_event",
      organizationId: ids.organization, openingId: ids.opening, createdByUserId: ids.userA,
      createdByDeviceId: ids.device, createdAtLocal, updatedAtLocal: createdAtLocal, serverRevision: null,
      baseSnapshotHash: null, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", syncState: "queued",
      retryCount: 0, payload },
    operation: { operationId, operationType: "create", entityType: "service_event", entityId,
      openingId: ids.opening, organizationId: ids.organization, actorUserId: ids.userA, deviceId: ids.device,
      baseServerRevision: null, payload, payloadHash: "a".repeat(64), dependencyOperationIds: [],
      createdAtLocal, state: "queued", attemptCount: 0, schemaVersion: OFFLINE_SCHEMA_VERSION,
      appVersion: "test", protocolVersion: SYNC_PROTOCOL_VERSION },
  };
}

beforeEach(() => {
  setSyncReadOnly(false);
  apiState.calls = 0;
  apiState.loseFirstResponse = false;
  apiState.accepted.clear();
  apiState.afterAccepted = undefined;
});

afterEach(async () => {
  setSyncReadOnly(false);
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe("flush interruption recovery", () => {
  it('finishes recording an already sent result but stops subsequent dispatch on QR navigation', async () => {
    const first=records(1),second=records(2);
    await saveEntityAndOperation(first.entity,first.operation);await saveEntityAndOperation(second.entity,second.operation);
    await saveAuth({token:'synthetic-a',userId:ids.userA,organizationId:ids.organization,role:'admin'});
    apiState.afterAccepted=async()=>{setSyncReadOnly(true);};
    await flushVersionedOperations();
    const rows=await getSyncOperationsForOpening(ids.opening);
    expect(apiState.calls).toBe(1);expect(rows.find(r=>r.operationId===first.operation.operationId)?.state).toBe('verified');
    expect(rows.find(r=>r.operationId===second.operation.operationId)?.state).toBe('queued');
    await flushVersionedOperations();expect(apiState.calls).toBe(1);
    setSyncReadOnly(false);apiState.afterAccepted=undefined;await flushVersionedOperations();expect(apiState.calls).toBe(2);
  });
  it('QR sign-in preserves stopped operations without requeue or dispatch',async()=>{
    const item=records(1);item.operation.state='auth_required';item.operation.principalChangeStop=true;
    await saveEntityAndOperation(item.entity,item.operation);
    const before=await getSyncOperationsForOpening(ids.opening);
    await recordFreshSignIn({token:'synthetic-a',userId:ids.userA,organizationId:ids.organization,role:'admin'},false,false);
    expect(await getSyncOperationsForOpening(ids.opening)).toEqual(before);expect(apiState.calls).toBe(0);
  });
  it("replays the same operation ID after response loss following server acceptance", async () => {
    const { entity, operation } = records(1);
    await saveEntityAndOperation(entity, operation);
    await saveAuth({ token: "token-a", userId: ids.userA, organizationId: ids.organization, role: "technician" });
    apiState.loseFirstResponse = true;
    await flushVersionedOperations();
    const [waiting] = await getSyncOperationsForOpening(ids.opening);
    expect(waiting).toMatchObject({ operationId: operation.operationId, state: "retry_wait",
      lastErrorCode: "response_lost_after_server_acceptance" });

    await putSyncOperation({ ...waiting, state: "queued", nextAttemptAt: undefined });
    apiState.loseFirstResponse = false;
    await flushVersionedOperations();
    const [verified] = await getSyncOperationsForOpening(ids.opening);
    expect(verified).toMatchObject({ operationId: operation.operationId, state: "verified" });
    expect(apiState.calls).toBe(2);
    expect(apiState.accepted.size).toBe(1);
  });

  it("stops after an account switch and leaves the next principal-owned operation queued", async () => {
    const first = records(1);
    const second = records(2);
    await saveEntityAndOperation(first.entity, first.operation);
    await saveEntityAndOperation(second.entity, second.operation);
    await saveAuth({ token: "token-a", userId: ids.userA, organizationId: ids.organization, role: "technician" });
    apiState.afterAccepted = async () => {
      apiState.afterAccepted = undefined;
      await saveAuth({ token: "token-b", userId: ids.userB, organizationId: ids.organization, role: "technician" });
    };

    // The pass now stops quietly when the signed-in account changes (it used to reject unhandled).
    // This test replaces submitOfflineOperation, so the request wrapper's check after the response does
    // not run here; tests/principalChangeRecovery.test.ts covers that path through the real wrapper.
    await expect(flushVersionedOperations()).resolves.toBeUndefined();
    const operations = await getSyncOperationsForOpening(ids.opening);
    expect(operations.find((item) => item.operationId === first.operation.operationId)?.state).toBe("verified");
    expect(operations.find((item) => item.operationId === second.operation.operationId)?.state).toBe("queued");
    expect(apiState.calls).toBe(1);
  });
});
