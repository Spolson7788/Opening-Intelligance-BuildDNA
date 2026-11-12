import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { closeFieldAppDb, getOfflineSetting, getSyncOperationsForPrincipal, putOfflineSetting, putSyncOperation, requeueFinishedVisitInspection, saveAuth } from "../field-app/src/lib/db";
import { ensureOpenVisit, finishVisit, pendingInspectionIds, readOpenVisit, readVisitById, reconcileOpenVisit, recordVisitInspection, startNewVisit, visitSummaryText, visitUploadMessage, withInspection } from "../field-app/src/lib/inspectionVisit";
import { syncIssueCanDiscard, syncIssueMessage } from "../field-app/src/lib/syncIssueMessage";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import { selectedFacilityKey } from "../field-app/src/lib/facilitySync";

const userId = "55555555-5555-4555-8555-555555555555";
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const facilityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

afterEach(async () => {
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

it("joins the server's open visit when this phone lost the pointer", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  await putOfflineSetting({ key: selectedFacilityKey({ userId, organizationId }), value: facilityId, updatedAt: new Date().toISOString() });
  const serverId = "191f5a79-1534-49fb-b486-c4bff94195b7";
  let lookups = 0;
  const joined = await ensureOpenVisit(async () => {
    lookups += 1;
    return { id: serverId, inspections: [{ inspectionId: "insp-510", openingId: "door-510", passed: true }] };
  });
  expect(joined?.id).toBe(serverId);
  expect(lookups).toBe(1);
  const again = await ensureOpenVisit(async () => { throw new Error("lookup"); });
  expect(again?.id).toBe(serverId);
  expect((await readOpenVisit())?.inspections).toHaveLength(1);
});

it("keeps an explicit new visit instead of jumping back to the server visit", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  await putOfflineSetting({ key: selectedFacilityKey({ userId, organizationId }), value: facilityId, updatedAt: new Date().toISOString() });
  await ensureOpenVisit(async () => ({ id: "191f5a79-1534-49fb-b486-c4bff94195b7", inspections: [] }));
  const started = await startNewVisit();
  const next = await ensureOpenVisit(async () => ({ id: "191f5a79-1534-49fb-b486-c4bff94195b7", inspections: [] }));
  expect(next?.id).toBe(started?.id);
  expect(next?.id).not.toBe("191f5a79-1534-49fb-b486-c4bff94195b7");
});

it("reuses one visit for the same facility and does not duplicate a repeated save", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  await putOfflineSetting({ key: selectedFacilityKey({ userId, organizationId }), value: facilityId, updatedAt: new Date().toISOString() });
  const first = await ensureOpenVisit();
  const second = await ensureOpenVisit();
  expect(first?.id).toBe(second?.id);
  expect(first?.facilityId).toBe(facilityId);
  await recordVisitInspection(first!.id, { inspectionId: "insp-1", openingId: "door-1", passed: false, inspectedAt: "2026-11-09T10:57:00.000Z" });
  await recordVisitInspection(first!.id, { inspectionId: "insp-1", openingId: "door-1", passed: false });
  await recordVisitInspection(first!.id, { inspectionId: "insp-2", openingId: "door-2", passed: true, inspectedAt: "2026-11-09T11:00:00.000Z" });
  const stored = await readVisitById(first!.id);
  expect(stored?.inspections).toHaveLength(2);
  expect(stored?.facilityId).toBe(facilityId);
  expect(visitSummaryText(stored!.inspections)).toBe("This visit: 2 openings (1 passed, 1 failed)");
  await recordVisitInspection(first!.id, { inspectionId: "insp-1b", openingId: "door-1", passed: true, inspectedAt: "2026-11-09T12:07:00.000Z" });
  const repeated = await readVisitById(first!.id);
  expect(repeated?.inspections).toHaveLength(3);
  expect(visitSummaryText(repeated!.inspections)).toBe("This visit: 2 openings (2 passed, 0 failed)");
  const pointer = await getOfflineSetting(`inspection-visit-open:${userId}:${organizationId}:${facilityId}`);
  expect(pointer?.value).toBe(first!.id);
  expect(withInspection(stored!, { inspectionId: "insp-1", openingId: "door-1", passed: false }).inspections).toHaveLength(2);
});

it("blocks a combined report while a later door in the same visit is still off the server", () => {
  const local = ["210A-inspection", "310A-inspection"];
  const stillQueued = pendingInspectionIds(local, [
    { entityId: "210A-inspection", entityType: "inspection_event", state: "verified" },
    { entityId: "310A-inspection", entityType: "inspection_event", state: "queued" },
  ], ["210A-inspection"]);
  expect(stillQueued).toEqual(["310A-inspection"]);
  expect(visitUploadMessage(stillQueued.length)).toBe("1 inspection(s) are still uploading, try again");
  expect(pendingInspectionIds(local, [], ["210A-inspection", "310A-inspection"])).toEqual([]);
  expect(pendingInspectionIds(local, [], null)).toEqual(local);
});

it("starts a new visit after the combined report is sent and keeps a finished-visit inspection", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  await putOfflineSetting({ key: selectedFacilityKey({ userId, organizationId }), value: facilityId, updatedAt: new Date().toISOString() });
  const first = await ensureOpenVisit();
  await recordVisitInspection(first!.id, { inspectionId: "insp-210a", openingId: "door-210a", passed: true });
  await finishVisit(first!.id);
  const next = await ensureOpenVisit();
  expect(next?.id).not.toBe(first?.id);
  expect(next?.status).toBe("open");
  const kept = await readVisitById(first!.id);
  expect(kept?.status).toBe("finished");
  expect(syncIssueCanDiscard({ status: "permanent_failure", error: "visit_finished" })).toBe(false);
  expect(syncIssueMessage("permanent_failure", "visit_finished")).toContain("still on this device");
  expect(syncIssueMessage("permanent_failure", "visit_finished")).not.toContain("discard");
  await putSyncOperation({
    operationId: "22222222-2222-4222-8222-222222222222", operationType: "create", entityType: "inspection_event",
    entityId: "11111111-1111-4111-8111-111111111111", openingId: "door-210a", organizationId, actorUserId: userId,
    deviceId: "66666666-6666-4666-8666-666666666666", baseServerRevision: null,
    payload: { inspection_type: "fire_door_nfpa80", visit_id: first!.id }, payloadHash: "a".repeat(64),
    dependencyOperationIds: [], createdAtLocal: "2026-11-09T12:07:00.000Z", state: "permanent_failure",
    attemptCount: 1, lastErrorCode: "visit_finished", schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test",
    protocolVersion: SYNC_PROTOCOL_VERSION,
  });
  await requeueFinishedVisitInspection("22222222-2222-4222-8222-222222222222", null);
  const standalone = (await getSyncOperationsForPrincipal(userId, organizationId))[0];
  expect(standalone.state).toBe("queued");
  expect(standalone.payload).not.toHaveProperty("visit_id");
  const created = await startNewVisit();
  await putSyncOperation({ ...standalone, state: "permanent_failure", lastErrorCode: "visit_finished", payload: { inspection_type: "fire_door_nfpa80", visit_id: first!.id } });
  await requeueFinishedVisitInspection(standalone.operationId, created!.id);
  const moved = (await getSyncOperationsForPrincipal(userId, organizationId))[0];
  expect((moved.payload as { visit_id?: string }).visit_id).toBe(created?.id);
  expect(moved.payload && JSON.stringify(moved.payload)).not.toContain(first!.id);
});

it("clears a finished server visit on scan load and keeps an inspection that is not on the server", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  await putOfflineSetting({ key: selectedFacilityKey({ userId, organizationId }), value: facilityId, updatedAt: new Date().toISOString() });
  const visit = await ensureOpenVisit();
  await recordVisitInspection(visit!.id, { inspectionId: "insp-1", openingId: "door-1", passed: true });
  await recordVisitInspection(visit!.id, { inspectionId: "insp-2", openingId: "door-2", passed: true });
  await recordVisitInspection(visit!.id, { inspectionId: "insp-3", openingId: "door-3", passed: false });
  await putSyncOperation({
    operationId: "33333333-3333-4333-8333-333333333333", operationType: "create", entityType: "inspection_event",
    entityId: "insp-3", openingId: "door-3", organizationId, actorUserId: userId,
    deviceId: "66666666-6666-4666-8666-666666666666", baseServerRevision: null,
    payload: { inspection_type: "fire_door_nfpa80", visit_id: visit!.id }, payloadHash: "b".repeat(64),
    dependencyOperationIds: [], createdAtLocal: "2026-11-09T12:07:00.000Z", state: "queued",
    attemptCount: 0, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", protocolVersion: SYNC_PROTOCOL_VERSION,
  });
  const closed = await reconcileOpenVisit(async () => ({ status: "finished", report_sent: true, inspection_ids: ["insp-1", "insp-2"] }));
  expect(closed).toBeNull();
  expect(await readOpenVisit()).toBeNull();
  expect((await readVisitById(visit!.id))?.inspections).toHaveLength(3);
  expect((await getSyncOperationsForPrincipal(userId, organizationId)).map((item) => item.entityId)).toEqual(["insp-3"]);
  const next = await ensureOpenVisit();
  const left = await reconcileOpenVisit(async () => { throw new Error("offline"); });
  expect(left?.id).toBe(next?.id);
});
