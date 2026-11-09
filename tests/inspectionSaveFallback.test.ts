import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ failsLeft: 0, writes: 0, resets: 0, readFails: 0, rejectNext: false }));
const posts = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("../field-app/src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field-app/src/lib/db")>();
  return {
    ...actual,
    resetFieldAppDb: () => { control.resets += 1; return actual.resetFieldAppDb(); },
    saveEntityAndOperation: async (...args: Parameters<typeof actual.saveEntityAndOperation>) => {
      control.writes += 1;
      if (control.failsLeft > 0) { control.failsLeft -= 1; throw new Error("queue failed"); }
      return actual.saveEntityAndOperation(...args);
    },
    getSyncOperationsForPrincipal: async (...args: Parameters<typeof actual.getSyncOperationsForPrincipal>) => {
      if (control.readFails > 0) { control.readFails -= 1; throw new Error("queue failed"); }
      return actual.getSyncOperationsForPrincipal(...args);
    },
  };
});

vi.mock("../field-app/src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field-app/src/lib/api")>();
  return {
    ...actual,
    submitOfflineOperation: vi.fn(async (payload: Record<string, unknown>) => {
      posts.calls.push(payload);
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
import { closeFieldAppDb, saveAuth } from "../field-app/src/lib/db";
import { inspectionSaveFailureMessage } from "../field-app/src/lib/inspectionPhoto";
import { noteSyncDiagnostic, onSyncStateChange, queueOpeningMutation, refreshPendingCount, runLocalWrite } from "../field-app/src/lib/sync";

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
