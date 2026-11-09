import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeFieldAppDb, getOfflineMedia, getSyncOperationsForPrincipal, putSyncOperation, removeUnconfirmedLocalPhoto, saveAuth } from "../field-app/src/lib/db";
import { inspectionSaveFailureMessage, lowStorageWarning, queueInspectionFailurePhoto } from "../field-app/src/lib/inspectionPhoto";
import { noteSyncDiagnostic, onSyncStateChange } from "../field-app/src/lib/sync";
import { MAX_IMAGE_BYTES } from "../field-app/src/lib/mediaLimits";

const userId = "55555555-5555-4555-8555-555555555555";
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const openingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(async () => {
  await closeFieldAppDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("opening-intel-field");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe("inspection failure photos stay out of the inspection payload", () => {
  it("keeps a photograph above 2 MB on the phone when it cannot be reduced", async () => {
    await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
    const file = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: "image/jpeg" });
    const result = await queueInspectionFailurePhoto(openingId, file, "holes-breaks.jpg");
    expect(result.kind).toBe("kept");
    if (result.kind !== "kept") return;
    expect(result.message).toContain("inspection was not saved");
    const operations = await getSyncOperationsForPrincipal(userId, organizationId);
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe("permanent_failure");
    expect(operations[0].entityType).toBe("photo");
    const media = await getOfflineMedia(operations[0].entityId);
    expect(media?.uploadState).toBe("permanent_failure");
    expect(media?.byteSize).toBe(file.size);
  });

  it("does not call a missing sign-in an unreadable photo", async () => {
    const file = new Blob([new Uint8Array(32)], { type: "image/jpeg" });
    const result = await queueInspectionFailurePhoto(openingId, file, "hole.jpg");
    expect(result.kind).toBe("auth");
    if (result.kind === "queued") return;
    expect(result.message).toContain("Sign in");
    expect(result.message).not.toContain("could not be read");
  });

  it("keeps a server rejection distinct from an unreadable photo", async () => {
    const saved = inspectionSaveFailureMessage(new Error("new row violates row-level security policy for table inspection_visits"));
    expect(saved).toContain("remains saved on this device");
    expect(saved).not.toContain("inspection was not saved");
    expect(saved).not.toContain("could not be read");
    const storage = new DOMException("Connection to Indexed Database server lost", "UnknownError");
    expect(inspectionSaveFailureMessage(storage)).toBe("This device's storage had a problem. Close and reopen the app, then try again. Your entries are kept on this screen.");
    expect(inspectionSaveFailureMessage(storage)).not.toContain("could not queue");
    expect(inspectionSaveFailureMessage(new DOMException("quota", "QuotaExceededError"))).not.toContain("could not queue");
    expect(inspectionSaveFailureMessage(new DOMException("closed", "InvalidStateError"))).not.toContain("could not queue");
    expect(inspectionSaveFailureMessage(new DOMException("aborted", "AbortError"))).not.toContain("could not queue");
    expect(inspectionSaveFailureMessage(new Error("queue failed"))).toContain("could not queue");
    expect(inspectionSaveFailureMessage(new Error("photo_unreadable"))).toContain("could not be read");
    let diagnostic = "";
    const stop = onSyncStateChange((state) => { diagnostic = state.diagnostic ?? ""; });
    noteSyncDiagnostic(storage);
    expect(diagnostic).toContain("UnknownError: Connection to Indexed Database server lost");
    stop();
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 100, usage: 99 }) } });
    expect(await lowStorageWarning()).toContain("almost out of storage");
    vi.unstubAllGlobals();
  });

  it("does not queue a photo when the blob cannot be read", async () => {
    await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
    const file = new Blob(["not-a-photo"], { type: "image/jpeg" });
    Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("ios blob")) });
    const result = await queueInspectionFailurePhoto(openingId, file, "holes-breaks.jpg");
    expect(result.kind).toBe("unreadable");
    expect(await getSyncOperationsForPrincipal(userId, organizationId)).toEqual([]);
  });

  it("reuses the same photo and operation id when the inspection is saved again", async () => {
    await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
    const file = new Blob([new Uint8Array(32)], { type: "image/jpeg" });
    const reuse = { photoId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222" };
    const first = await queueInspectionFailurePhoto(openingId, file, "hole.jpg", reuse);
    const second = await queueInspectionFailurePhoto(openingId, file, "hole.jpg", reuse);
    expect(first).toMatchObject({ kind: "queued", photoId: reuse.photoId });
    expect(second).toMatchObject({ kind: "queued", photoId: reuse.photoId });
    const operations = await getSyncOperationsForPrincipal(userId, organizationId);
    expect(operations).toHaveLength(1);
    expect(operations[0].operationId).toBe(reuse.operationId);
    expect(operations[0].entityId).toBe(reuse.photoId);
  });

  it("leaves a photo that already synced when a later save is cancelled", async () => {
    await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
    const file = new Blob([new Uint8Array(32)], { type: "image/jpeg" });
    const result = await queueInspectionFailurePhoto(openingId, file, "kept.jpg");
    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;
    const [operation] = await getSyncOperationsForPrincipal(userId, organizationId);
    await putSyncOperation({ ...operation, state: "verified" });
    expect(await removeUnconfirmedLocalPhoto(result.photoId)).toBe(false);
    expect(await getSyncOperationsForPrincipal(userId, organizationId)).toHaveLength(1);
    expect(await getOfflineMedia(result.photoId)).toBeTruthy();
  });
});
