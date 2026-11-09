import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { closeFieldAppDb, getOfflineMedia, getSyncOperationsForPrincipal, putSyncOperation, removeUnconfirmedLocalPhoto, saveAuth } from "../field-app/src/lib/db";
import { queueInspectionFailurePhoto } from "../field-app/src/lib/inspectionPhoto";
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

  it("does not queue a photo when the blob cannot be read", async () => {
    await saveAuth({ token: "preview.e30.sig", userId, organizationId, role: "inspector" });
    const file = new Blob(["not-a-photo"], { type: "image/jpeg" });
    Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("ios blob")) });
    const result = await queueInspectionFailurePhoto(openingId, file, "holes-breaks.jpg");
    expect(result.kind).toBe("unreadable");
    expect(await getSyncOperationsForPrincipal(userId, organizationId)).toEqual([]);
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
