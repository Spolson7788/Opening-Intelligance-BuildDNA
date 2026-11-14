import { describe, expect, it } from "vitest";
import { dependencyIdsForOperation } from "../field-app/src/lib/sync";
import { readyOperations } from "../field-app/src/lib/offlineSyncModel";
import type { SyncOperation } from "../field-app/src/lib/offlineTypes";

const openingId = "11111111-1111-4111-8111-111111111111";
function operation(entityType: SyncOperation["entityType"], entityId: string, operationId: string, dependencies: string[] = []): SyncOperation {
  return { operationId, operationType: entityType === "completion" ? "complete" : "create", entityType, entityId,
    openingId, organizationId: "22222222-2222-4222-8222-222222222222",
    actorUserId: "33333333-3333-4333-8333-333333333333", deviceId: "44444444-4444-4444-8444-444444444444",
    baseServerRevision: null, payload: {}, payloadHash: "a".repeat(64), dependencyOperationIds: dependencies,
    createdAtLocal: "2026-09-19T12:00:00.000Z", state: dependencies.length ? "blocked_dependency" : "queued",
    attemptCount: 0, schemaVersion: 3, appVersion: "test", protocolVersion: 1 };
}

describe("offline operation dependencies", () => {
  it("binds components and photos to unsynchronized permanent parent identities", () => {
    const frame = operation("frame", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666");
    const leaf = operation("door_leaf", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888");
    expect(dependencyIdsForOperation([frame, leaf], "component", openingId, { door_leaf_id: leaf.entityId })).toEqual([leaf.operationId]);
    expect(dependencyIdsForOperation([frame, leaf], "photo", openingId, { target_type: "frame", target_id: frame.entityId })).toEqual([frame.operationId]);
  });

  it("retains every outstanding mutation for the same parent identity", () => {
    const first = operation("frame", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666");
    const second = operation("frame", first.entityId, "77777777-7777-4777-8777-777777777777");
    expect(dependencyIdsForOperation([first, second], "photo", openingId, { target_type: "frame", target_id: first.entityId }))
      .toEqual([first.operationId, second.operationId]);
  });

  it("makes dependent operations eligible during the same flush after each parent receipt", () => {
    const parent = operation("frame", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666");
    const child = operation("photo", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", [parent.operationId]);
    const verified = new Set<string>();
    expect(readyOperations([parent, child], verified, "2026-09-19T12:01:00.000Z").map((item) => item.operationId)).toEqual([parent.operationId]);
    verified.add(parent.operationId);
    expect(readyOperations([child], verified, "2026-09-19T12:01:00.000Z").map((item) => item.operationId)).toEqual([child.operationId]);
  });

  it("holds a fire-door inspection until its failure photo is confirmed", () => {
    const photoId = "99999999-9999-4999-8999-999999999999";
    const photo = operation("photo", photoId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const payload = { checklist_result: { items: { holes_breaks: { photo_id: photoId, result: "fail" } } } };
    expect(dependencyIdsForOperation([photo], "inspection_event", openingId, payload)).toEqual([photo.operationId]);
    const inspection = operation("inspection_event", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", [photo.operationId]);
    const verified = new Set<string>();
    expect(readyOperations([photo, inspection], verified, "2026-09-19T12:01:00.000Z").map((item) => item.operationId)).toEqual([photo.operationId]);
    verified.add(photo.operationId);
    expect(readyOperations([inspection], verified, "2026-09-19T12:01:00.000Z").map((item) => item.operationId)).toEqual([inspection.operationId]);
    expect(dependencyIdsForOperation([{ ...photo, state: "verified" }], "inspection_event", openingId, payload)).toEqual([]);
  });

  it("blocks completion on every unsynchronized frame, leaf, and component for the same opening", () => {
    const parents = [
      operation("frame", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"),
      operation("door_leaf", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"),
      operation("component", "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ];
    expect(dependencyIdsForOperation(parents, "completion", openingId, {})).toEqual(parents.map((item) => item.operationId));
  });
});
