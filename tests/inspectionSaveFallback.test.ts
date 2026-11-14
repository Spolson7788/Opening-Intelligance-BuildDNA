import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ failsLeft: 0, writes: 0, resets: 0, readFails: 0, rejectNext: false, blockRetry: false, photos: 0, hangReads: false, hangWrite: false, hangFlush: false, hangPost: false }));
const posts = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("../field-app/src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field-app/src/lib/db")>();
  return {
    ...actual,
    resetFieldAppDb: () => { control.resets += 1; return actual.resetFieldAppDb(); },
    saveEntityAndOperation: async (...args: Parameters<typeof actual.saveEntityAndOperation>) => {
      if (control.hangWrite) return new Promise(() => {});
      control.writes += 1;
      if (control.failsLeft > 0) {
        control.failsLeft -= 1;
        if (control.failsLeft === 0 && control.blockRetry) throw new DOMException("IndexedDB open blocked", "AbortError");
        throw new Error("queue failed");
      }
      return actual.saveEntityAndOperation(...args);
    },
    saveMediaAndOperation: async (...args: Parameters<typeof actual.saveMediaAndOperation>) => {
      control.writes += 1;
      if (control.failsLeft > 0) { control.failsLeft -= 1; throw new Error("queue failed"); }
      return actual.saveMediaAndOperation(...args);
    },
    getSyncOperationsForPrincipal: async (...args: Parameters<typeof actual.getSyncOperationsForPrincipal>) => {
      if (control.hangFlush) { control.hangFlush = false; return new Promise(() => {}); }
      if (control.readFails > 0) { control.readFails -= 1; throw new Error("queue failed"); }
      return actual.getSyncOperationsForPrincipal(...args);
    },
    getAllSyncOperations: async (...args: Parameters<typeof actual.getAllSyncOperations>) => {
      if (control.hangReads) return new Promise(() => {});
      return actual.getAllSyncOperations(...args);
    },
  };
});

vi.mock("../field-app/src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field-app/src/lib/api")>();
  return {
    ...actual,
    reserveOfflinePhoto: vi.fn(async () => { control.photos += 1; return { status: "verified" }; }),
    confirmOfflinePhoto: vi.fn(async () => { control.photos += 1; return {}; }),
    uploadPrivatePhoto: vi.fn(async () => {}),
    submitOfflineOperation: vi.fn(async (payload: Record<string, unknown>) => {
      posts.calls.push(payload);
      if (control.hangPost) return new Promise(() => {});
      if (control.rejectNext) { control.rejectNext = false; throw new actual.ApiError(409, "visit_finished"); }
      return {
        operation_id: payload.operation_id, entity_id: payload.entity_id, entity_type: payload.entity_type,
        opening_id: payload.opening_id, organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        resulting_server_revision: 1, normalized_record_hash: "abc",
        server_accepted_at: "2026-11-09T23:00:00.000Z", verified_at: "2026-11-09T23:00:00.000Z",
      };
    }),
  };
});

import { ApiError } from "../field-app/src/lib/api";
import { closeFieldAppDb, combineDatabaseOpen, getAllSyncOperations, saveAuth } from "../field-app/src/lib/db";
import { inspectionSaveFailureMessage, lowStorageWarning, queueInspectionFailurePhoto } from "../field-app/src/lib/inspectionPhoto";
import { flushOutbox, noteSyncDiagnostic, onSyncStateChange, queueOpeningMutation, refreshPendingCount, runLocalWrite } from "../field-app/src/lib/sync";

const userId = "55555555-5555-4555-8555-555555555555";
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const openingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const operationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

afterEach(async () => {
  posts.calls.length = 0;
  control.failsLeft = 0;
  control.writes = 0;
  control.resets = 0;
  control.readFails = 0;
  control.rejectNext = false;
  control.blockRetry = false;
  control.photos = 0;
  control.hangReads = false;
  control.hangWrite = false;
  control.hangFlush = false;
  control.hangPost = false;
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  vi.unstubAllGlobals();
});

function online(value: boolean) {
  vi.stubGlobal("navigator", { onLine: value });
}

function inspectionPayload() {
  return {
    opening_id: openingId, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80",
    passed: false, visit_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", checklist_result: { status: "complete", items: {} },
  };
}

it("shows an unrecognized error name and records it", () => {
  const error = new Error("queue failed");
  const text = inspectionSaveFailureMessage(error);
  expect(text).toContain("could not queue the inspection");
  expect(text).toContain("Error: queue failed");
  expect(inspectionSaveFailureMessage(new DOMException("The object store was not found", "NotFoundError"))).toContain("NotFoundError");
  expect(inspectionSaveFailureMessage(new DOMException("could not clone", "DataCloneError"))).toContain("DataCloneError");
  expect(inspectionSaveFailureMessage(new DOMException("inactive", "TransactionInactiveError"))).toContain("TransactionInactiveError");
  expect(inspectionSaveFailureMessage(new DOMException("insecure", "SecurityError"))).toContain("SecurityError");
  const indexed = inspectionSaveFailureMessage(new Error("An internal error was encountered in the Indexed Database server"));
  expect(indexed).toContain("storage had a problem");
  expect(indexed).toContain("Indexed Database");
  expect(indexed).not.toContain("remains saved on this device");
  expect(inspectionSaveFailureMessage(new Error("oi_data_wiped"))).toContain("oi_data_wiped");
  expect(inspectionSaveFailureMessage(new Error("media_operation_identity_mismatch"))).toContain("media_operation_identity_mismatch");
  expect(inspectionSaveFailureMessage(new Error("active_principal_changed"))).toContain("Sign in again");
  expect(inspectionSaveFailureMessage(new Error("active_principal_changed"))).toContain("active_principal_changed");
  expect(inspectionSaveFailureMessage(new Error("internal_error"))).toContain("remains saved on this device");
  let diagnostic = "";
  const stop = onSyncStateChange((state) => { diagnostic = state.diagnostic ?? ""; });
  noteSyncDiagnostic(error, true);
  expect(diagnostic).toContain("Error: queue failed");
  stop();
});

it("drops the cached database and retries a local write once", async () => {
  let calls = 0;
  const saved = await runLocalWrite(async () => {
    calls += 1;
    if (calls === 1) throw new Error("queue failed");
    return "stored";
  });
  expect(saved).toBe("stored");
  expect(calls).toBe(2);
  expect(control.resets).toBe(1);
});

it("rejects a blocked database open without waiting", async () => {
  let rejectBlocked: (error: DOMException) => void = () => {};
  const blocked = new Promise<string>((_, reject) => { rejectBlocked = reject; });
  const pending = combineDatabaseOpen(new Promise<string>(() => {}), blocked, 1000);
  const started = Date.now();
  rejectBlocked(new DOMException("IndexedDB open blocked", "AbortError"));
  await expect(pending).rejects.toThrow(/blocked/);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(inspectionSaveFailureMessage(new DOMException("IndexedDB open timed out", "TimeoutError"))).toContain("TimeoutError");
});

it("posts one no-photo inspection after the reopen is blocked", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.failsLeft = 2;
  control.blockRetry = true;
  let diagnostic = "";
  const stop = onSyncStateChange((state) => { diagnostic = state.diagnostic ?? ""; });
  const started = Date.now();
  const saved = await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(saved).toBe(operationId);
  expect(posts.calls).toHaveLength(1);
  expect(posts.calls[0].operation_id).toBe(operationId);
  expect((posts.calls[0].payload as { visit_id: string }).visit_id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  expect(diagnostic).toContain("AbortError");
  expect(diagnostic).toContain("blocked");
  stop();
});

it("queues a photo-backed inspection once and does not post it twice", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.failsLeft = 0;
  await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  await vi.waitFor(() => expect(posts.calls.length).toBe(1));
  expect(posts.calls[0].operation_id).toBe(operationId);
  expect(control.photos).toBe(0);
});

it("uploads a failure photo when its local write throws and does not hang", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.failsLeft = 2;
  const started = Date.now();
  const result = await queueInspectionFailurePhoto(openingId, new Blob([new Uint8Array(32)], { type: "image/jpeg" }), "hole.jpg");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result.kind).toBe("queued");
  expect(control.photos).toBeGreaterThan(0);
  expect(control.writes).toBe(2);
});

it("posts one inspection online after the local queue fails twice", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.failsLeft = 2;
  const saved = await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  expect(saved).toBe(operationId);
  expect(control.writes).toBe(2);
  expect(posts.calls).toHaveLength(1);
  expect(posts.calls[0].operation_id).toBe(operationId);
  expect((posts.calls[0].payload as { visit_id: string }).visit_id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  control.failsLeft = 0;
  control.writes = 0;
  await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  await vi.waitFor(() => expect(posts.calls.length).toBeGreaterThan(1));
  expect(posts.calls.every((call) => call.operation_id === operationId)).toBe(true);
});

it("keeps the local error when the phone is offline", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(false);
  control.failsLeft = 2;
  await expect(queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId)).rejects.toThrow("queue failed");
  expect(posts.calls).toHaveLength(0);
  expect(inspectionSaveFailureMessage(new Error("queue failed"))).toContain("queue failed");
});

it("leaves a server rejection for the form to show", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.failsLeft = 2;
  control.rejectNext = true;
  await expect(queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId)).rejects.toMatchObject({ status: 409, message: "visit_finished" });
  expect(inspectionSaveFailureMessage(new ApiError(409, "visit_finished"))).toContain("409: visit_finished");
  expect(inspectionSaveFailureMessage(new ApiError(409, "visit_finished"))).toContain("was not saved");
});

it("posts one no-photo inspection when the operation read never settles", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.hangReads = true;
  const started = Date.now();
  let caught: unknown;
  try {
    await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  } catch (error) { caught = error; }
  expect(Date.now() - started).toBeLessThan(6_000);
  expect(caught).toBeInstanceOf(Error);
  expect(inspectionSaveFailureMessage(caught)).toContain("TimeoutError");
  expect(inspectionSaveFailureMessage(caught)).toContain("sent to the server");
  expect(posts.calls).toHaveLength(1);
  expect(posts.calls[0].operation_id).toBe(operationId);
  expect((posts.calls[0].payload as { visit_id: string }).visit_id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  control.hangReads = false;
  expect((await getAllSyncOperations()).some((item) => item.operationId === operationId)).toBe(false);
});

it("stops Saving when the server got the inspection but the response never finishes", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.failsLeft = 2;
  control.hangPost = true;
  const started = Date.now();
  let caught: unknown;
  try {
    await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  } catch (error) { caught = error; }
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(caught).toMatchObject({ name: "TimeoutError", sentToServer: true });
  expect(inspectionSaveFailureMessage(caught)).toContain("sent to the server");
  expect(posts.calls).toHaveLength(1);
  control.hangPost = false;
});

it("clears Syncing when a confirmed inspection's upload never finishes", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(false);
  await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  online(true);
  control.hangPost = true;
  let syncing = true;
  let lastError = "";
  const stop = onSyncStateChange((state) => { syncing = state.syncing; lastError = state.lastError ?? ""; });
  await flushOutbox(40);
  expect(syncing).toBe(false);
  expect(lastError).toMatch(/timed out/);
  stop();
  control.hangPost = false;
});

it("posts one inspection when the local write never settles and keeps stored rows", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  await vi.waitFor(() => expect(posts.calls.some((call) => call.operation_id === operationId)).toBe(true));
  const before = (await getAllSyncOperations()).length;
  expect(before).toBeGreaterThan(0);
  posts.calls.length = 0;
  control.hangWrite = true;
  const otherId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await expect(queueOpeningMutation("inspection_event", openingId, inspectionPayload(), otherId)).rejects.toThrow(/timed out/);
  expect(posts.calls).toHaveLength(1);
  expect(posts.calls[0].operation_id).toBe(otherId);
  control.hangWrite = false;
  const stored = await getAllSyncOperations();
  expect(stored).toHaveLength(before);
  expect(stored.some((item) => item.operationId === otherId)).toBe(false);
  expect(stored.some((item) => item.operationId === operationId)).toBe(true);
});

it("posts one inspection when the payload digest never settles", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(() => new Promise(() => {}) as Promise<ArrayBuffer>);
  try {
    await expect(queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId)).rejects.toThrow(/timed out/);
    expect(posts.calls).toHaveLength(1);
    expect(posts.calls[0].operation_id).toBe(operationId);
  } finally { digest.mockRestore(); }
});

it("treats a storage estimate that never settles as unknown", async () => {
  vi.stubGlobal("navigator", { onLine: true, storage: { estimate: () => new Promise(() => {}) } });
  const started = Date.now();
  await expect(lowStorageWarning()).resolves.toBeNull();
  expect(Date.now() - started).toBeLessThan(4_000);
});

it("closes the shared database when a flush read never settles", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  online(true);
  control.hangFlush = true;
  control.resets = 0;
  let syncing = true;
  const stop = onSyncStateChange((state) => { syncing = state.syncing; });
  const started = Date.now();
  await flushOutbox(50);
  expect(Date.now() - started).toBeLessThan(6_000);
  expect(syncing).toBe(false);
  expect(control.resets).toBeGreaterThan(0);
  stop();
  control.hangFlush = false;
  posts.calls.length = 0;
  let stillSyncing = false;
  const watch = onSyncStateChange((state) => { stillSyncing = state.syncing; });
  const saved = await queueOpeningMutation("inspection_event", openingId, inspectionPayload(), operationId);
  expect(saved).toBe(operationId);
  await vi.waitFor(() => expect(posts.calls.length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(stillSyncing).toBe(false));
  watch();
});

it("records a pending-count failure and reopens the database", async () => {
  await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
  control.readFails = 1;
  control.resets = 0;
  let diagnostic = "";
  const stop = onSyncStateChange((state) => { diagnostic = state.diagnostic ?? ""; });
  await refreshPendingCount();
  expect(control.resets).toBeGreaterThan(0);
  expect(diagnostic).toContain("queue failed");
  stop();
});
