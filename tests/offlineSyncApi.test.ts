import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { pool } from "../src/db/pool";
import {
  buildPrivatePhotoStorageKey,
  verifyStoredPhoto,
} from "../src/services/storage";
import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";

const photoId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const checksum = "a".repeat(64);

function reservation(openingId: string, overrides: Record<string, unknown> = {}) {
  return {
    photo_id: photoId,
    client_operation_id: operationId,
    opening_id: openingId,
    target_type: "opening",
    target_id: openingId,
    original_filename: "IMG_1001.JPG",
    content_type: "image/jpeg",
    byte_size: 12345,
    sha256_checksum: checksum,
    device_id: deviceId,
    ...overrides,
  };
}

function componentOperation(openingId: string, overrides: Record<string, unknown> = {}) {
  return {
    operation_id: randomUUID(),
    entity_id: randomUUID(),
    opening_id: openingId,
    device_id: deviceId,
    payload_hash: "c".repeat(64),
    base_server_revision: null,
    schema_version: 3,
    app_version: "phase-2-test",
    protocol_version: 1,
    payload: {
      component_type: "hinge",
      mounting_scope: "opening",
      position_label: "top",
      condition: "good",
      identity_status: "established",
      review_state: "reviewed",
      replacement_required: false,
    },
    ...overrides,
  };
}

describe("offline synchronization API foundation", () => {
  it("creates the additive receipt, audit, and private-photo reservation tables", async () => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [["sync_operation_receipts", "sync_audit_events", "photo_upload_reservations"]],
    );
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([
      "photo_upload_reservations", "sync_audit_events", "sync_operation_receipts",
    ]);
  });

  it("adds revision and private media verification columns", async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='photos'`,
    );
    const columns = result.rows.map((row) => row.column_name);
    expect(columns).toEqual(expect.arrayContaining([
      "revision", "organization_id", "content_type", "byte_size", "sha256_checksum",
      "storage_object_key", "upload_state", "storage_verified_at",
      "authorized_retrieval_verified_at", "captured_by_device_id",
    ]));
  });

  it("uses an immutable private object key based on tenant, opening, and photo identity", () => {
    expect(buildPrivatePhotoStorageKey("org-a", "opening-a", "photo-a", "image/jpeg")).toBe(
      "private/org/org-a/opening/opening-a/photo/photo-a.jpg",
    );
  });

  it("requires all stored object metadata to match", () => {
    const expected = { byteSize: 42, contentType: "image/jpeg", sha256Checksum: checksum, photoId };
    expect(verifyStoredPhoto(expected, { ...expected })).toEqual([]);
    expect(verifyStoredPhoto(expected, {
      byteSize: 41,
      contentType: "image/png",
      sha256Checksum: "b".repeat(64),
      photoId: operationId,
    })).toEqual(["byte_size_mismatch", "content_type_mismatch", "checksum_mismatch", "photo_id_mismatch"]);
  });

  it("denies a reservation for another organization's opening before storage access", async () => {
    const owner = await signupTestOrg("Photo owner");
    const outsider = await signupTestOrg("Photo outsider");
    const { buildingId } = await createPortfolioHierarchy(owner.token);
    const opening = await createTestOpening(owner.token, buildingId);
    const response = await request(app)
      .post("/api/photos/offline/reserve")
      .set("Authorization", `Bearer ${outsider.token}`)
      .send(reservation(opening.id));
    expect(response.status).toBe(403);
  });

  it("rejects a hierarchy target that does not belong to the opening", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const response = await request(app)
      .post("/api/photos/offline/reserve")
      .set("Authorization", `Bearer ${org.token}`)
      .send(reservation(opening.id, { target_type: "frame", target_id: photoId }));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("photo_target_not_in_opening");
  });

  it("does not persist a reservation when private storage is not configured", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const keys = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => delete process.env[key]);
    try {
      const response = await request(app)
        .post("/api/photos/offline/reserve")
        .set("Authorization", `Bearer ${org.token}`)
        .send(reservation(opening.id));
      expect(response.status).toBe(503);
      expect(response.body.error).toBe("storage_not_configured");
      const rows = await pool.query(
        "SELECT 1 FROM photo_upload_reservations WHERE organization_id=$1 AND operation_id=$2",
        [org.organizationId, operationId],
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      for (const key of keys) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
  });

  it("does not confirm a photo without an owned reservation", async () => {
    const org = await signupTestOrg();
    const response = await request(app)
      .post("/api/photos/offline/confirm")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        photo_id: photoId,
        client_operation_id: operationId,
        payload_hash: "b".repeat(64),
        schema_version: 3,
        app_version: "phase-2-test",
        protocol_version: 1,
      });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("reservation_not_found");
  });

  it("creates an offline component with its permanent ID, receipt, revision, and audit event", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const body = componentOperation(opening.id);
    const response = await request(app)
      .post("/api/sync/components")
      .set("Authorization", `Bearer ${org.token}`)
      .send(body);
    expect(response.status).toBe(201);
    expect(response.body.entity_id).toBe(body.entity_id);
    expect(response.body.resulting_server_revision).toBe("1");
    expect(response.body.status).toBe("accepted");

    const component = await pool.query("SELECT * FROM hardware_components WHERE id=$1", [body.entity_id]);
    expect(component.rows[0].opening_id).toBe(opening.id);
    expect(component.rows[0].client_operation_id).toBe(body.operation_id);
    expect(component.rows[0].revision).toBe("1");
    const audit = await pool.query("SELECT * FROM sync_audit_events WHERE operation_id=$1", [body.operation_id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("component_created_offline");
  });

  it("replays the same component operation without creating a duplicate", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const body = componentOperation(opening.id);
    const first = await request(app).post("/api/sync/components").set("Authorization", `Bearer ${org.token}`).send(body);
    const replay = await request(app).post("/api/sync/components").set("Authorization", `Bearer ${org.token}`).send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("already_applied");
    const count = await pool.query("SELECT count(*)::int AS count FROM hardware_components WHERE client_operation_id=$1", [body.operation_id]);
    expect(count.rows[0].count).toBe(1);
  });

  it("rejects reuse of an operation ID for a different entity", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const body = componentOperation(opening.id);
    await request(app).post("/api/sync/components").set("Authorization", `Bearer ${org.token}`).send(body);
    const conflict = await request(app)
      .post("/api/sync/components")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ ...body, entity_id: randomUUID() });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("idempotency_key_reused");
  });

  it("keeps multiple same-class components as separate records", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const first = componentOperation(opening.id);
    const second = componentOperation(opening.id, {
      payload_hash: "d".repeat(64),
      payload: { ...componentOperation(opening.id).payload, position_label: "bottom" },
    });
    expect((await request(app).post("/api/sync/components").set("Authorization", `Bearer ${org.token}`).send(first)).status).toBe(201);
    expect((await request(app).post("/api/sync/components").set("Authorization", `Bearer ${org.token}`).send(second)).status).toBe(201);
    const rows = await pool.query(
      "SELECT id, position_label FROM hardware_components WHERE opening_id=$1 AND component_type='hinge' ORDER BY position_label",
      [opening.id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.id).sort()).toEqual([first.entity_id, second.entity_id].sort());
  });

  it("denies an offline component operation against another organization", async () => {
    const owner = await signupTestOrg("Component owner");
    const outsider = await signupTestOrg("Component outsider");
    const { buildingId } = await createPortfolioHierarchy(owner.token);
    const opening = await createTestOpening(owner.token, buildingId);
    const response = await request(app)
      .post("/api/sync/components")
      .set("Authorization", `Bearer ${outsider.token}`)
      .send(componentOperation(opening.id));
    expect(response.status).toBe(403);
  });
});
