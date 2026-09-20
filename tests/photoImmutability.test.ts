import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const storage = vi.hoisted(() => ({
  objects: new Map<string, { bytes: Buffer; contentType: string; checksum: string; photoId: string; etag: string }>(),
  lastUploadKey: "",
  presignCalls: 0,
}));

vi.mock("../src/services/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/storage")>();
  return {
    ...actual,
    assertStorageConfigured: () => undefined,
    getPresignedPrivatePhotoUploadUrl: async (input: any) => {
      storage.lastUploadKey = input.key;
      storage.presignCalls += 1;
      return `https://upload.invalid/${input.key}`;
    },
    headPrivatePhoto: async (key: string) => {
      const object = storage.objects.get(key);
      if (!object) return { byteSize: -1, contentType: "" };
      return { byteSize: object.bytes.byteLength, contentType: object.contentType,
        sha256Checksum: object.checksum, photoId: object.photoId, etag: object.etag };
    },
    verifyPrivatePhotoRetrieval: async (key: string, checksum: string, maximumBytes: number) => {
      const object = storage.objects.get(key);
      return !!object && object.bytes.byteLength <= maximumBytes &&
        createHash("sha256").update(object.bytes).digest("hex") === checksum;
    },
    promotePrivatePhotoObject: async ({ uploadKey, finalKey, sourceEtag }: any) => {
      const source = storage.objects.get(uploadKey);
      if (!source || source.etag !== sourceEtag) throw new Error("source_changed_during_promotion");
      storage.objects.set(finalKey, { ...source, bytes: Buffer.from(source.bytes), etag: `final-${source.etag}` });
    },
    deleteObject: async (key: string) => { storage.objects.delete(key); },
  };
});

import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";

describe("immutable private-photo confirmation", () => {
  beforeEach(() => {
    storage.objects.clear();
    storage.lastUploadKey = "";
    storage.presignCalls = 0;
  });

  it("promotes verified bytes once and never reauthorizes upload after confirmation", async () => {
    const org = await signupTestOrg("Immutable photo");
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const bytes = Buffer.from("immutable-original");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const photoId = randomUUID();
    const operationId = randomUUID();
    const reservation = { photo_id: photoId, client_operation_id: operationId, opening_id: opening.id,
      target_type: "opening", target_id: opening.id, original_filename: "capture.jpg",
      content_type: "image/jpeg", byte_size: bytes.byteLength, sha256_checksum: checksum,
      device_id: randomUUID(), schema_version: 3, app_version: "immutability-test", protocol_version: 1 };

    const reserved = await request(app).post("/api/photos/offline/reserve")
      .set("Authorization", `Bearer ${org.token}`).send(reservation);
    expect(reserved.status).toBe(201);
    expect(storage.presignCalls).toBe(1);
    const uploadKey = storage.lastUploadKey;
    storage.objects.set(uploadKey, { bytes, contentType: "image/jpeg", checksum, photoId, etag: "upload-v1" });

    const confirmed = await request(app).post("/api/photos/offline/confirm")
      .set("Authorization", `Bearer ${org.token}`).send({ photo_id: photoId, client_operation_id: operationId,
        schema_version: 3, app_version: "immutability-test", protocol_version: 1 });
    expect(confirmed.status).toBe(201);
    const finalKey = reserved.body.storage_object_key;
    expect(storage.objects.get(finalKey)?.bytes.equals(bytes)).toBe(true);

    // A stale or malicious client may still try the temporary key, but replay
    // neither grants a new URL nor consults those changed bytes.
    storage.objects.set(uploadKey, { bytes: Buffer.from("changed"), contentType: "image/jpeg",
      checksum: createHash("sha256").update("changed").digest("hex"), photoId, etag: "upload-v2" });
    const replayReservation = await request(app).post("/api/photos/offline/reserve")
      .set("Authorization", `Bearer ${org.token}`).send(reservation);
    expect(replayReservation.status).toBe(200);
    expect(replayReservation.body).toMatchObject({ status: "verified" });
    expect(replayReservation.body.upload_url).toBeUndefined();
    expect(storage.presignCalls).toBe(1);

    const replayConfirmation = await request(app).post("/api/photos/offline/confirm")
      .set("Authorization", `Bearer ${org.token}`).send({ photo_id: photoId, client_operation_id: operationId,
        schema_version: 3, app_version: "immutability-test", protocol_version: 1 });
    expect(replayConfirmation.status).toBe(200);
    expect(replayConfirmation.body.status).toBe("already_applied");
    expect(storage.objects.get(finalKey)?.bytes.equals(bytes)).toBe(true);
  });
});
