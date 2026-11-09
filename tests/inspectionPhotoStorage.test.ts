import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { failingFireDoorFields } from "./nfpa80Fixture";

const storage = vi.hoisted(() => ({
  objects: new Map<string, { bytes: Buffer; contentType: string; checksum: string; photoId: string; etag: string }>(),
  lastUploadKey: "",
}));
vi.mock("../src/services/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/storage")>();
  return {
    ...actual,
    assertStorageConfigured: () => undefined,
    getPresignedPrivatePhotoUploadUrl: async (input: { key: string }) => {
      storage.lastUploadKey = input.key;
      return `https://upload.invalid/${input.key}`;
    },
    getPresignedPrivatePhotoReadUrl: async (key: string) => `https://signed.invalid/${key}`,
    headPrivatePhoto: async (key: string) => {
      const object = storage.objects.get(key);
      if (!object) return { byteSize: -1, contentType: "" };
      return { byteSize: object.bytes.byteLength, contentType: object.contentType, sha256Checksum: object.checksum, photoId: object.photoId, etag: object.etag };
    },
    verifyPrivatePhotoRetrieval: async (key: string, checksum: string, maximumBytes: number) => {
      const object = storage.objects.get(key);
      return !!object && object.bytes.byteLength <= maximumBytes && createHash("sha256").update(object.bytes).digest("hex") === checksum;
    },
    promotePrivatePhotoObject: async ({ uploadKey, finalKey, sourceEtag }: { uploadKey: string; finalKey: string; sourceEtag: string }) => {
      const source = storage.objects.get(uploadKey);
      if (!source || source.etag !== sourceEtag) throw new Error("source_changed_during_promotion");
      storage.objects.set(finalKey, { ...source, bytes: Buffer.from(source.bytes), etag: `final-${source.etag}` });
    },
    deleteObject: async (key: string) => { storage.objects.delete(key); },
  };
});
import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";

describe("inspection photos use confirmed private storage", () => {
  beforeEach(() => { storage.objects.clear(); storage.lastUploadKey = ""; });

  it("confirms the failure photo before the inspection and does not store new bytes inline", async () => {
    const org = await signupTestOrg("Inspection photo");
    const other = await signupTestOrg("Other company");
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const photoId = randomUUID();
    const operationId = randomUUID();
    const auth = { Authorization: `Bearer ${org.token}` };
    const reserved = await request(app).post("/api/photos/offline/reserve").set(auth).send({
      photo_id: photoId, client_operation_id: operationId, opening_id: opening.id,
      target_type: "opening", target_id: opening.id, original_filename: "holes-breaks.jpg",
      content_type: "image/jpeg", byte_size: bytes.byteLength, sha256_checksum: checksum, device_id: randomUUID(),
    });
    expect(reserved.status).toBe(201);
    storage.objects.set(storage.lastUploadKey, { bytes, contentType: "image/jpeg", checksum, photoId, etag: "upload-v1" });
    expect((await request(app).post("/api/photos/offline/confirm").set(auth).send({
      photo_id: photoId, client_operation_id: operationId, schema_version: 3, app_version: "inspection-photo", protocol_version: 1,
    })).status).toBe(201);

    const fields = failingFireDoorFields();
    const items = fields.checklist_result.items as Record<string, { result: string; note?: string; photo_base64?: string }>;
    delete items.labels.photo_base64;
    items.labels = { result: "fail", note: "Hole in the face", photo_id: photoId } as typeof items.labels;
    const created = await request(app).post("/api/events/inspection-events").set(auth).send({
      opening_id: opening.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80",
      ...fields, checklist_result: { status: "complete", items },
    });
    expect(created.status).toBe(201);
    const detail = await request(app).get(`/api/openings/${opening.id}`).set(auth);
    const photo = detail.body.photos.find((item: { id: string }) => item.id === photoId);
    expect(photo.storage_url.startsWith("private:")).toBe(true);
    expect(photo.related_entity_type).toBe("inspection_event");
    expect(photo.inline_bytes).toBeUndefined();
    expect(detail.body.photos.some((item: { storage_url?: string }) => String(item.storage_url).startsWith("inline:"))).toBe(false);
    const access = await request(app).get(`/api/photos/${photoId}/access`).set(auth);
    expect(access.status).toBe(200);
    expect(access.body.url).toContain("https://signed.invalid/");
    expect((await request(app).get(`/api/photos/${photoId}/access`).set("Authorization", `Bearer ${other.token}`)).status).toBe(404);
    expect((await request(app).get(`/api/photos/${photoId}/content`).set("Authorization", `Bearer ${other.token}`)).status).toBe(404);
  });
});
