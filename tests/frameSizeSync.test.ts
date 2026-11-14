import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool";
import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";

const api = vi.hoisted(() => ({
  calls: [] as Array<{ operation_id: string; base_server_revision: number | null; width_in?: number }>,
  serverRevision: 3,
  conflict: false,
}));

vi.mock("../field-app/src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field-app/src/lib/api")>();
  return {
    ...actual,
    submitOfflineOperation: async (input: { operation_id: string; entity_id: string; entity_type: string; opening_id: string; base_server_revision: number | null; payload: { width_in?: number } }) => {
      api.calls.push({ operation_id: input.operation_id, base_server_revision: input.base_server_revision, width_in: input.payload.width_in });
      if (api.conflict && input.base_server_revision !== api.serverRevision) {
        const error = new actual.ApiError(409, "revision_conflict");
        error.serverRevision = api.serverRevision;
        throw error;
      }
      return {
        operation_id: input.operation_id, entity_id: input.entity_id, entity_type: input.entity_type,
        opening_id: input.opening_id, organization_id: "44444444-4444-4444-8444-444444444444",
        resulting_server_revision: (input.base_server_revision ?? 0) + 1, normalized_record_hash: "b".repeat(64),
        server_accepted_at: "2026-11-11T17:30:00.000Z", verified_at: "2026-11-11T17:30:01.000Z", status: "accepted",
      };
    },
  };
});

import { closeFieldAppDb, getSyncOperationsForOpening, saveAuth } from "../field-app/src/lib/db";
import { flushOutbox, flushVersionedOperations, queueOpeningMutation } from "../field-app/src/lib/sync";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import { saveEntityAndOperation } from "../field-app/src/lib/db";

const organization = "44444444-4444-4444-8444-444444444444";
const user = "55555555-5555-4555-8555-555555555555";
const opening = "33333333-3333-4333-8333-333333333333";
const frame = "88888888-8888-4888-8888-888888888888";

beforeEach(async () => {
  api.calls = [];
  api.conflict = false;
  api.serverRevision = 3;
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  await saveAuth({ token: "token", userId: user, organizationId: organization, role: "technician" });
});

afterEach(async () => {
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

it("replaces a pending frame write with the newer size and flushes once online", async () => {
  await queueOpeningMutation("opening_frame", opening, { id: frame, expected_revision: 2, width_in: 47, height_in: 96, condition: "good" });
  await queueOpeningMutation("opening_frame", opening, { id: frame, expected_revision: 2, width_in: 48, height_in: 96, condition: "good" });
  const queued = await getSyncOperationsForOpening(opening);
  expect(queued).toHaveLength(1);
  expect(queued[0].payload).toMatchObject({ width_in: 48, height_in: 96 });
  expect(api.calls).toHaveLength(0);
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  await flushOutbox();
  expect(api.calls).toHaveLength(1);
  expect(api.calls[0]).toMatchObject({ operation_id: queued[0].operationId, base_server_revision: 2, width_in: 48 });
  expect((await getSyncOperationsForOpening(opening))[0].state).toBe("verified");
});

it("rebases a size conflict onto the server revision and finishes the flush", async () => {
  api.conflict = true;
  const now = "2026-11-11T16:43:00.000Z";
  const operationId = "99999999-9999-4999-8999-999999999999";
  const payload = { kind: "opening_frame", id: frame, expected_revision: 2, width_in: 48, height_in: 96, condition: "good" };
  await saveEntityAndOperation(
    { key: entityKey("frame", frame), id: frame, entityType: "frame", organizationId: organization, openingId: opening,
      createdByUserId: user, createdByDeviceId: "77777777-7777-4777-8777-777777777777", createdAtLocal: now, updatedAtLocal: now,
      serverRevision: null, baseSnapshotHash: null, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", syncState: "conflict",
      retryCount: 1, lastErrorCode: "revision_conflict", payload },
    { operationId, operationType: "update", entityType: "frame", entityId: frame, openingId: opening, organizationId: organization,
      actorUserId: user, deviceId: "77777777-7777-4777-8777-777777777777", baseServerRevision: 2, payload, payloadHash: "a".repeat(64),
      dependencyOperationIds: [], createdAtLocal: now, state: "conflict", attemptCount: 1, lastErrorCode: "revision_conflict",
      schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", protocolVersion: SYNC_PROTOCOL_VERSION },
  );
  await flushVersionedOperations();
  expect(api.calls.map((call) => call.base_server_revision)).toEqual([2, 3]);
  expect(api.calls[1].width_in).toBe(48);
  expect((await getSyncOperationsForOpening(opening))[0].state).toBe("verified");
});

it("accepts a newer frame size after reporting the current revision", async () => {
  const org = await signupTestOrg();
  const { buildingId } = await createPortfolioHierarchy(org.token);
  const created = await createTestOpening(org.token, buildingId);
  const auth = { Authorization: `Bearer ${org.token}` };
  const frameSave = await request(app).put(`/api/openings/${created.id}/frame`).set(auth).send({ material: "Steel", condition: "good", width_in: 36, height_in: 84 });
  expect(frameSave.status).toBe(200);
  const stale = await request(app).post("/api/sync/operations").set(auth).send({
    operation_id: randomUUID(), entity_id: frameSave.body.id, opening_id: created.id, device_id: randomUUID(),
    base_server_revision: 99, schema_version: 3, app_version: "test", protocol_version: 1,
    entity_type: "frame", operation_type: "update", payload: { width_in: 47, height_in: 96, condition: "good" },
  });
  expect(stale.status).toBe(409);
  expect(stale.body.error).toBe("revision_conflict");
  expect(stale.body.server_revision).toBe(Number(frameSave.body.revision));
  const fresh = await request(app).post("/api/sync/operations").set(auth).send({
    operation_id: randomUUID(), entity_id: frameSave.body.id, opening_id: created.id, device_id: randomUUID(),
    base_server_revision: stale.body.server_revision, schema_version: 3, app_version: "test", protocol_version: 1,
    entity_type: "frame", operation_type: "update", payload: { width_in: 48, height_in: 96, condition: "good" },
  });
  expect(fresh.status).toBe(201);
  const stored = await pool.query("SELECT width_in, height_in, revision FROM opening_frames WHERE id=$1", [frameSave.body.id]);
  expect(Number(stored.rows[0].width_in)).toBe(48);
  expect(Number(stored.rows[0].height_in)).toBe(96);
  expect(Number(stored.rows[0].revision)).toBe(Number(stale.body.server_revision) + 1);
});
