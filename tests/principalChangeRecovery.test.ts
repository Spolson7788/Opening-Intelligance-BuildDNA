import {escapedGateHtml} from './fixtures/netlifyGate';
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests run the Field App's real request wrapper (authedFetch in api.ts), sync loop and
// IndexedDB code. Only the network is replaced: global fetch answers as the API and storage would,
// keyed by the bearer token, so the account checks before and after each response run for real.
import { closeFieldAppDb, getAllSyncOperations, getOfflineMedia, loadAuth, claimSyncOperation,
  retrySyncOperationAfterReview, saveAuth, saveEntityAndOperation, saveMediaAndOperation,
  putSyncOperation, removeVerifiedLocalOriginal, getOpenConflictsForPrincipal } from "../field-app/src/lib/db";
import { flushVersionedOperations } from "../field-app/src/lib/sync";
import { recordFreshSignIn } from "../field-app/src/lib/freshSignIn";
import { entityKey, OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../field-app/src/lib/offlineTypes";
import type { OfflineEntityEnvelope, OfflineMediaRecord, SyncOperation } from "../field-app/src/lib/offlineTypes";

const org = { a: "11111111-1111-4111-8111-111111111111", b: "22222222-2222-4222-8222-222222222222" };
const user = { a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const account = {
  a: { token: "token-a", userId: user.a, organizationId: org.a, role: "technician" },
  b: { token: "token-b", userId: user.b, organizationId: org.b, role: "technician" },
  c: { token: "token-c", userId: user.c, organizationId: org.a, role: "technician" }, // same company as A, different person
};
const opening = "33333333-3333-4333-8333-333333333333";
const component = "44444444-4444-4444-8444-444444444444";
const device = "77777777-7777-4777-8777-777777777777";

// ---- simulated API and storage ------------------------------------------------------------------
const server = {
  reservations: new Map<string, { operationId: string; actor: string; status: "reserved" | "verified" }>(),
  receipts: new Map<string, number>(),          // operation id -> times applied (1 = once)
  photos: new Map<string, number>(),            // photo id -> server copies
  calls: [] as string[],
  revoked: new Set<string>(),                    // user ids whose access was removed
  expired: new Set<string>(),                    // tokens the server now refuses as expired
  afterConfirmApplied: undefined as undefined | (() => Promise<void>),
  afterOperationApplied: undefined as undefined | (() => Promise<void>),
};
const tokenUser: Record<string, { userId: string; organizationId: string }> = {
  "token-a": { userId: user.a, organizationId: org.a }, "token-a2": { userId: user.a, organizationId: org.a },
  "token-b": { userId: user.b, organizationId: org.b }, "token-c": { userId: user.c, organizationId: org.a },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("current conflict diagnostics", () => {
  it("retains the same queued bytes and identifiers across a private-site gate and resumes once without signing in again", async () => {
    const p = photoFor(account.a);
    await saveMediaAndOperation(p.media, p.operation);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(escapedGateHtml, {status:401,headers:{'content-type':'text/html'}})));
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({state:'retry_wait',lastErrorCode:'site_access_required',entityId:p.media.photoId});
    expect(await loadAuth()).toMatchObject(account.a);
    expect(await (await getOfflineMedia(p.media.photoId))!.blob.arrayBuffer()).toEqual(await p.media.blob.arrayBuffer());
    await closeFieldAppDb();
    // Advance the existing backoff for the simulation; never create a replacement operation.
    const retained = await opOf(p.operation.operationId);
    await putSyncOperation({...retained,nextAttemptAt:new Date(0).toISOString()});
    vi.stubGlobal('fetch',vi.fn(fakeFetch));
    await flushVersionedOperations();
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({state:'verified',entityId:p.media.photoId});
    expect(server.reservations.size).toBe(1);expect(server.photos.get(p.media.photoId)).toBe(1);
    expect(server.receipts.get(p.operation.operationId)).toBe(1);
    expect(await (await getOfflineMedia(p.media.photoId))!.blob.arrayBuffer()).toEqual(await p.media.blob.arrayBuffer());
  });
  it("replaces a stale network error with the 409 reason atomically and retains the same photo for reviewed retry", async () => {
    const p = photoFor(account.a);
    p.operation.lastErrorCode = "Failed to fetch";
    await saveMediaAndOperation(p.media, p.operation);
    vi.stubGlobal("fetch", vi.fn(async () => json(409, { error: "idempotency_key_reused" })));
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "conflict", lastErrorCode: "idempotency_key_reused" });
    const retained = await getOfflineMedia(p.media.photoId);
    expect(retained).toMatchObject({ photoId: p.media.photoId, operationId: p.operation.operationId, uploadState: "conflict" });
    expect(await retained!.blob.arrayBuffer()).toEqual(await p.media.blob.arrayBuffer());
    expect(await getOpenConflictsForPrincipal(user.a, org.a)).toHaveLength(1);
    await closeFieldAppDb();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "conflict", lastErrorCode: "idempotency_key_reused" });
    await retrySyncOperationAfterReview(p.operation.operationId, true);
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "queued", entityId: p.media.photoId });
    expect((await opOf(p.operation.operationId)).lastErrorCode).toBeUndefined();
    expect(await getOpenConflictsForPrincipal(user.a, org.a)).toHaveLength(0);
    expect(await (await getOfflineMedia(p.media.photoId))!.blob.arrayBuffer()).toEqual(await p.media.blob.arrayBuffer());
  });
});
function receipt(operationId: string, entityId: string, entityType: string, organizationId: string, status: string) {
  return { operation_id: operationId, entity_id: entityId, entity_type: entityType, opening_id: opening, organization_id: organizationId,
    resulting_server_revision: 1, normalized_record_hash: "b".repeat(64), server_accepted_at: "2026-10-02T12:00:00.000Z",
    verified_at: "2026-10-02T12:00:01.000Z", media_object_verified: true, authorized_retrieval_verified: true, status };
}
async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || "GET").toUpperCase();
  server.calls.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  if (url.startsWith("https://storage.test/")) return new Response(null, { status: 200 });
  const auth = (init.headers as Record<string, string>)?.Authorization?.replace("Bearer ", "") ?? "";
  if (server.expired.has(auth)) return json(401, { error: "token_expired", reference: "00000000-0000-4000-8000-000000000001" });
  const who = tokenUser[auth];
  if (!who) return json(401, { error: "invalid_token" });
  if (server.revoked.has(who.userId)) return json(403, { error: "forbidden" });
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (url.endsWith("/photos/offline/reserve")) {
    const existing = server.reservations.get(body.photo_id);
    if (existing && existing.operationId !== body.client_operation_id) return json(409, { error: "photo_id_reused" });
    const r = existing ?? { operationId: body.client_operation_id, actor: who.userId, status: "reserved" as const };
    server.reservations.set(body.photo_id, r);
    return json(existing ? 200 : 201, { photo_id: body.photo_id, client_operation_id: r.operationId,
      upload_url: r.status === "verified" ? undefined : `https://storage.test/private-upload/${r.operationId}`, status: r.status });
  }
  if (url.endsWith("/photos/offline/confirm")) {
    const r = server.reservations.get(body.photo_id);
    if (!r) return json(404, { error: "reservation_not_found" });
    if (r.actor !== who.userId) return json(403, { error: "reservation_actor_mismatch" });
    const applied = server.receipts.get(body.client_operation_id) ?? 0;
    if (!applied) { server.photos.set(body.photo_id, (server.photos.get(body.photo_id) ?? 0) + 1); r.status = "verified"; }
    server.receipts.set(body.client_operation_id, applied + 1);
    if (server.afterConfirmApplied) { const hook = server.afterConfirmApplied; server.afterConfirmApplied = undefined; await hook(); }
    return json(applied ? 200 : 201, receipt(body.client_operation_id, body.photo_id, "photo", who.organizationId, applied ? "already_applied" : "accepted"));
  }
  if (url.endsWith("/sync/operations") || url.endsWith("/sync/components")) {
    const applied = server.receipts.get(body.operation_id) ?? 0;
    server.receipts.set(body.operation_id, applied + 1);
    if (server.afterOperationApplied) { const hook = server.afterOperationApplied; server.afterOperationApplied = undefined; await hook(); }
    return json(applied ? 200 : 201, receipt(body.operation_id, body.entity_id, url.endsWith("/sync/components") ? "component" : "service_event", who.organizationId, applied ? "already_applied" : "accepted"));
  }
  return json(404, { error: "not_found" });
}

// ---- local records -------------------------------------------------------------------------------
let seq = 0;
function photoFor(owner: typeof account.a): { media: OfflineMediaRecord; operation: SyncOperation } {
  seq += 1;
  const photoId = `55555555-5555-4555-8555-${String(seq).padStart(12, "0")}`;
  const operationId = `66666666-6666-4666-8666-${String(seq).padStart(12, "0")}`;
  const now = new Date(Date.now() - 60_000).toISOString();
  return {
    media: { photoId, operationId, openingId: opening, organizationId: owner.organizationId, targetType: "hardware_component", targetId: component,
      capturedAtDevice: now, capturedByUserId: owner.userId, capturedByDeviceId: device, originalFilename: "closer.jpg",
      generatedCaptureName: `${photoId}.jpeg`, contentType: "image/jpeg", byteSize: 4, sha256Checksum: "c".repeat(64),
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }), localBlobState: "retained", uploadState: "queued",
      provenanceState: "original", reviewState: "pending", createdAtLocal: now, updatedAtLocal: now } as OfflineMediaRecord,
    operation: { operationId, operationType: "confirm_media", entityType: "photo", entityId: photoId, openingId: opening,
      organizationId: owner.organizationId, actorUserId: owner.userId, deviceId: device, baseServerRevision: null,
      payload: { target_type: "hardware_component", target_id: component }, payloadHash: "c".repeat(64), dependencyOperationIds: [],
      createdAtLocal: now, state: "queued", attemptCount: 0, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", protocolVersion: SYNC_PROTOCOL_VERSION },
  };
}
function serviceEventFor(owner: typeof account.a): { entity: OfflineEntityEnvelope; operation: SyncOperation } {
  seq += 1;
  const entityId = `88888888-8888-4888-8888-${String(seq).padStart(12, "0")}`;
  const operationId = `99999999-9999-4999-8999-${String(seq).padStart(12, "0")}`;
  const now = new Date(Date.now() - 60_000).toISOString();
  const payload = { kind: "service_event", id: entityId, opening_id: opening, event_date: "2026-10-02", work_performed: "adjusted closer", hardware_component_id: component };
  return {
    entity: { key: entityKey("service_event", entityId), id: entityId, entityType: "service_event", organizationId: owner.organizationId, openingId: opening,
      createdByUserId: owner.userId, createdByDeviceId: device, createdAtLocal: now, updatedAtLocal: now, serverRevision: null, baseSnapshotHash: null,
      schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", syncState: "queued", retryCount: 0, payload },
    operation: { operationId, operationType: "create", entityType: "service_event", entityId, openingId: opening, organizationId: owner.organizationId,
      actorUserId: owner.userId, deviceId: device, baseServerRevision: null, payload, payloadHash: "d".repeat(64), dependencyOperationIds: [],
      createdAtLocal: now, state: "queued", attemptCount: 0, schemaVersion: OFFLINE_SCHEMA_VERSION, appVersion: "test", protocolVersion: SYNC_PROTOCOL_VERSION },
  };
}
const opOf = async (operationId: string) => (await getAllSyncOperations()).find((o) => o.operationId === operationId)!;
// Technician A's confirmation is applied by the server, then B signs in on this device before A's
// browser receives the response.
const switchToBWhenConfirmApplied = () => { server.afterConfirmApplied = async () => { await recordFreshSignIn(account.b, false); }; };

describe("photo interruption and retention with mocked transport", () => {
  async function retainedBytes(photoId: string) {
    const media = await getOfflineMedia(photoId);
    expect(media?.localBlobState).toBe("retained");
    expect(Array.from(new Uint8Array(await media!.blob.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    await expect(removeVerifiedLocalOriginal(photoId)).rejects.toThrow("local_original_not_verified_for_cleanup");
  }

  it("retains original after lost confirmation, reopens IndexedDB, then replays without a second upload", async () => {
    const p = photoFor(account.a);
    await saveMediaAndOperation(p.media, p.operation);
    server.afterConfirmApplied = async () => { throw new TypeError("synthetic_confirmation_response_lost"); };
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "retry_wait", lastErrorCode: "synthetic_confirmation_response_lost" });
    expect(server.photos.get(p.media.photoId)).toBe(1);
    await retainedBytes(p.media.photoId);
    await closeFieldAppDb(); // Connection restart only; not a real browser crash.
    const waiting = await opOf(p.operation.operationId);
    await retainedBytes(p.media.photoId);
    await putSyncOperation({ ...waiting, state: "queued", nextAttemptAt: undefined });
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "verified", operationId: p.operation.operationId });
    expect(server.photos.get(p.media.photoId)).toBe(1);
    expect(server.calls.filter(c => c.startsWith("PUT /private-upload/")).length).toBe(1);
    const saved = await getOfflineMedia(p.media.photoId);
    expect(saved?.localBlobState).toBe("verified_cleanup_allowed");
    expect(Array.from(new Uint8Array(await saved!.blob.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it("retains original after interrupted upload and retries the same photo identity", async () => {
    const p = photoFor(account.a);
    await saveMediaAndOperation(p.media, p.operation);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") throw new TypeError("synthetic_upload_interrupted");
      return fakeFetch(input, init);
    }));
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "retry_wait" });
    expect(server.photos.size).toBe(0);
    expect(server.reservations.size).toBe(1);
    await retainedBytes(p.media.photoId);
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    await putSyncOperation({ ...await opOf(p.operation.operationId), state: "queued", nextAttemptAt: undefined });
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "verified", entityId: p.media.photoId });
    expect(server.reservations.size).toBe(1);
    expect(server.photos.get(p.media.photoId)).toBe(1);
  });

  it("does not permit cleanup when successful confirmation omits authorized retrieval proof", async () => {
    const p = photoFor(account.a);
    await saveMediaAndOperation(p.media, p.operation);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fakeFetch(input, init);
      if (String(input).endsWith("/photos/offline/confirm")) {
        return json(200, { ...await response.json(), authorized_retrieval_verified: false });
      }
      return response;
    }));
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "retry_wait", lastErrorCode: "receipt_media_proof_incomplete" });
    await retainedBytes(p.media.photoId);
  });
});

beforeEach(async () => {
  server.reservations.clear(); server.receipts.clear(); server.photos.clear(); server.calls = [];
  server.revoked.clear(); server.expired.clear(); server.afterConfirmApplied = undefined; server.afterOperationApplied = undefined;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  await saveAuth(account.a);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase("opening-intel-field"); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
});

describe("account switch while a confirmation is in flight (real request wrapper)", () => {
  it("stops A's photo as an account change, leaves it alone for B, and resumes it once when A signs in again", async () => {
    const p = photoFor(account.a); await saveMediaAndOperation(p.media, p.operation);
    switchToBWhenConfirmApplied();
    await expect(flushVersionedOperations()).resolves.toBeUndefined();               // no unhandled account-change error
    let op = await opOf(p.operation.operationId);
    expect(op).toMatchObject({ state: "auth_required", lastErrorCode: "active_principal_changed", principalChangeStop: true });
    expect(server.photos.get(p.media.photoId)).toBe(1);                                // the server applied it once

    await flushVersionedOperations();                                                 // B's pass: A's item is not B's
    expect((await opOf(p.operation.operationId)).state).toBe("auth_required");
    expect(server.calls.filter((c) => c.includes("/photos/offline/")).length).toBe(2);  // only A's reserve + confirm so far

    const resumed = await recordFreshSignIn(account.a, false);                        // fresh sign-in by A
    expect(resumed).toEqual([p.operation.operationId]);
    await flushVersionedOperations();
    op = await opOf(p.operation.operationId);
    expect(op).toMatchObject({ state: "verified", operationId: p.operation.operationId, entityId: p.media.photoId, autoRecoveryCount: 1 });
    expect((await getOfflineMedia(p.media.photoId))?.uploadState).toBe("verified");
    expect(server.photos.get(p.media.photoId)).toBe(1);                                // still exactly one server copy
    expect(server.calls.filter((c) => c.startsWith("PUT /private-upload/")).length).toBe(1); // replay did not upload again
  });

  it("allows at most one automatic attempt per fresh sign-in event", async () => {
    const p = photoFor(account.a); await saveMediaAndOperation(p.media, p.operation);
    switchToBWhenConfirmApplied();
    await flushVersionedOperations();
    await recordFreshSignIn(account.a, false);
    const auth = await loadAuth();
    switchToBWhenConfirmApplied();                                                     // the account changes again during the replay
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "auth_required", principalChangeStop: true, autoRecoveryCount: 1 });
    // The same sign-in event cannot resume it again.
    const { requeueAfterFreshSignIn } = await import("../field-app/src/lib/db");
    await saveAuth({ ...account.a, signInEventId: auth!.signInEventId });
    expect(await requeueAfterFreshSignIn({ userId: user.a, organizationId: org.a, signInEventId: auth!.signInEventId! })).toEqual([]);
    // A new sign-in event can.
    expect(await recordFreshSignIn(account.a, false)).toEqual([p.operation.operationId]);
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "verified", autoRecoveryCount: 2 });
    expect(server.photos.get(p.media.photoId)).toBe(1);
  });

  it("does not resume on a stored session that is merely reloaded (no fresh sign-in)", async () => {
    const p = photoFor(account.a); await saveMediaAndOperation(p.media, p.operation);
    switchToBWhenConfirmApplied();
    await flushVersionedOperations();
    await saveAuth(account.a);                                                         // e.g. stored session restored, no sign-in event
    await flushVersionedOperations();
    expect((await opOf(p.operation.operationId)).state).toBe("auth_required");
  });

  it("keeps a genuine server refusal stopped: A's access was removed before A signed in again", async () => {
    const p = photoFor(account.a); await saveMediaAndOperation(p.media, p.operation);
    switchToBWhenConfirmApplied();
    await flushVersionedOperations();
    server.revoked.add(user.a);
    await recordFreshSignIn(account.a, false);
    await flushVersionedOperations();
    const op = await opOf(p.operation.operationId);
    expect(op).toMatchObject({ state: "auth_required", lastErrorCode: "forbidden" });
    expect(op.principalChangeStop).toBeUndefined();
    expect((await getOfflineMedia(p.media.photoId))?.localBlobState).toBe("retained"); // kept on the device
    // A later sign-in does not retry a server refusal automatically.
    server.revoked.delete(user.a);
    expect(await recordFreshSignIn(account.a, false)).toEqual([]);
    // After access is restored the technician's manual retry completes it, still one server copy.
    await retrySyncOperationAfterReview(p.operation.operationId);
    await flushVersionedOperations();
    expect((await opOf(p.operation.operationId)).state).toBe("verified");
    expect(server.photos.get(p.media.photoId)).toBe(1);
  });

  it("leaves A's stopped item untouched when a third account signs in", async () => {
    const p = photoFor(account.a); await saveMediaAndOperation(p.media, p.operation);
    switchToBWhenConfirmApplied();
    await flushVersionedOperations();
    expect(await recordFreshSignIn(account.c, false)).toEqual([]);                     // C: same company as A, different user
    await flushVersionedOperations();
    expect(await opOf(p.operation.operationId)).toMatchObject({ state: "auth_required", principalChangeStop: true });
    expect(server.calls.filter((c) => c.includes("/photos/offline/")).length).toBe(2);
    await expect(retrySyncOperationAfterReview(p.operation.operationId)).rejects.toThrow("operation_principal_mismatch");
  });

  it("resumes a non-photo change (service event on a closer) the same way", async () => {
    const e = serviceEventFor(account.a); await saveEntityAndOperation(e.entity, e.operation);
    server.afterOperationApplied = async () => { await recordFreshSignIn(account.b, false); };
    await flushVersionedOperations();
    expect(await opOf(e.operation.operationId)).toMatchObject({ state: "auth_required", lastErrorCode: "active_principal_changed", principalChangeStop: true });
    expect(server.receipts.get(e.operation.operationId)).toBe(1);
    expect(await recordFreshSignIn(account.a, false)).toEqual([e.operation.operationId]);
    await flushVersionedOperations();
    expect(await opOf(e.operation.operationId)).toMatchObject({ state: "verified", operationId: e.operation.operationId });
    expect(server.receipts.get(e.operation.operationId)).toBe(2);                    // replayed once, applied once (already_applied)
  });

  it("keeps an expired session (server 401) stopped for review, not resumed automatically", async () => {
    const p = photoFor(account.a); await saveMediaAndOperation(p.media, p.operation);
    server.expired.add("token-a");
    await flushVersionedOperations();
    const op = await opOf(p.operation.operationId);
    expect(op).toMatchObject({ state: "auth_required", lastErrorCode: "token_expired" });
    expect(op.principalChangeStop).toBeUndefined();
    expect(await recordFreshSignIn({ ...account.a, token: "token-a2" }, false)).toEqual([]);
  });

  it("with two tabs, the resumed item is dispatched by only one (dispatch lease preserved)", async () => {
    const p = photoFor(account.a); await saveMediaAndOperation(p.media, p.operation);
    switchToBWhenConfirmApplied();
    await flushVersionedOperations();
    await recordFreshSignIn(account.a, false);
    // Another tab of A claims it first under its own lease.
    const other = await claimSyncOperation({ operationId: p.operation.operationId, userId: user.a, organizationId: org.a,
      leaseId: "other-tab-lease", nowIso: new Date().toISOString(), leaseDurationMs: 120_000 });
    expect(other?.dispatchLeaseId).toBe("other-tab-lease");
    const before = server.calls.length;
    await flushVersionedOperations();                                                // this tab must not dispatch it
    expect(server.calls.length).toBe(before);
    const op = await opOf(p.operation.operationId);
    expect(op).toMatchObject({ state: "in_flight", dispatchLeaseId: "other-tab-lease" });
    // A further sign-in event does not touch an item another tab holds.
    expect(await recordFreshSignIn(account.a, false)).toEqual([]);
    expect((await opOf(p.operation.operationId)).dispatchLeaseId).toBe("other-tab-lease");
  });
});

it.each(['opening','hardware_component'] as const)('preserves queued %s target in the real reservation request',async(targetType)=>{
  const p=photoFor(account.a);const targetId=targetType==='opening'?opening:component;
  p.media.targetType=targetType;p.media.targetId=targetId;
  p.operation.payload={...p.operation.payload,target_type:targetType,target_id:targetId};
  await saveMediaAndOperation(p.media,p.operation);
  const reserves:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    if(String(input).endsWith('/photos/offline/reserve'))reserves.push(JSON.parse(String(init?.body)));
    return fakeFetch(input,init);
  }));
  await flushVersionedOperations();
  expect(reserves).toHaveLength(1);expect(reserves[0]).toMatchObject({photo_id:p.media.photoId,target_type:targetType,target_id:targetId});
  expect(await opOf(p.operation.operationId)).toMatchObject({state:'verified'});
});
