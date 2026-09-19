import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { pool } from "../src/db/pool";
import {
  buildPrivatePhotoStorageKey,
  verifyStoredPhoto,
} from "../src/services/storage";
import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";
import { createOrReplayPhotoReservation, processPhotoDeletionJobs } from "../src/routes/photos";

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

  it("rejects declared media larger than the server-side limit before storage access", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const response = await request(app).post("/api/photos/offline/reserve")
      .set("Authorization", `Bearer ${org.token}`)
      .send(reservation(opening.id, { byte_size: 25 * 1024 * 1024 + 1 }));
    expect(response.status).toBe(413);
    expect(response.body.error).toBe("media_too_large");
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

  it("returns one immutable reservation for concurrent identical retries", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const user = await pool.query("SELECT id FROM users WHERE email=$1", [org.email]);
    const concurrentOperationId = randomUUID();
    const requested = { ...reservation(opening.id, { photo_id: randomUUID(), client_operation_id: concurrentOperationId }), actor_user_id: user.rows[0].id } as any;
    const [left, right] = await Promise.all([
      createOrReplayPhotoReservation(org.organizationId, requested),
      createOrReplayPhotoReservation(org.organizationId, requested),
    ]);
    expect(left.conflict).toBeUndefined();
    expect(right.conflict).toBeUndefined();
    expect(left.reservation.id).toBe(right.reservation.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    const rows = await pool.query("SELECT * FROM photo_upload_reservations WHERE operation_id=$1", [concurrentOperationId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].original_filename).toBe(requested.original_filename);
    expect(rows.rows[0].actor_user_id).toBe(requested.actor_user_id);
    expect(rows.rows[0].device_id).toBe(requested.device_id);
  });

  it("immutably retains photograph geolocation in its reservation", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const user = await pool.query("SELECT id FROM users WHERE email=$1", [org.email]);
    const requested = { ...reservation(opening.id, { photo_id: randomUUID(), client_operation_id: randomUUID(),
      latitude: 33.4484, longitude: -112.074 }), actor_user_id: user.rows[0].id } as any;
    const result = await createOrReplayPhotoReservation(org.organizationId, requested);
    expect(Number(result.reservation.latitude)).toBe(33.4484);
    expect(Number(result.reservation.longitude)).toBe(-112.074);
    const conflict = await createOrReplayPhotoReservation(org.organizationId, { ...requested, latitude: 33.5 });
    expect(conflict.conflict).toBe("idempotency_key_reused");
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

  it("computes the semantic payload hash on the server and ignores a forged client hash", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const body = componentOperation(opening.id, { payload_hash: "0".repeat(64) });
    const response = await request(app).post("/api/sync/components").set("Authorization", `Bearer ${org.token}`).send(body);
    expect(response.status).toBe(201);
    expect(response.body.payload_hash).not.toBe(body.payload_hash);
  });

  it("routes frame capture through the versioned endpoint with exactly-idempotent replay", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const body = {
      operation_id: randomUUID(), operation_type: "create", entity_id: randomUUID(), entity_type: "frame",
      opening_id: opening.id, device_id: deviceId, base_server_revision: null, schema_version: 3,
      app_version: "phase-2-test", protocol_version: 1, payload: { material: "Steel", condition: "good" },
    };
    const [first, replay] = [
      await request(app).post("/api/sync/operations").set("Authorization", `Bearer ${org.token}`).send(body),
      await request(app).post("/api/sync/operations").set("Authorization", `Bearer ${org.token}`).send(body),
    ];
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("already_applied");
    const rows = await pool.query("SELECT * FROM opening_frames WHERE opening_id=$1", [opening.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].client_operation_id).toBe(body.operation_id);
  });

  it("rejects a different client identity for an existing permanent frame", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const firstId = randomUUID();
    await request(app).post("/api/sync/operations").set("Authorization", `Bearer ${org.token}`).send({
      operation_id: randomUUID(), operation_type: "create", entity_id: firstId, entity_type: "frame",
      opening_id: opening.id, device_id: deviceId, base_server_revision: null, schema_version: 3,
      app_version: "phase-2-test", protocol_version: 1, payload: { material: "Steel" },
    });
    const conflict = await request(app).post("/api/sync/operations").set("Authorization", `Bearer ${org.token}`).send({
      operation_id: randomUUID(), operation_type: "create", entity_id: randomUUID(), entity_type: "frame",
      opening_id: opening.id, device_id: deviceId, base_server_revision: null, schema_version: 3,
      app_version: "phase-2-test", protocol_version: 1, payload: { material: "Aluminum" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: "permanent_entity_identity_conflict", entity_id: firstId });
  });

  it("rejects a different client identity for an existing permanent door leaf", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const firstId = randomUUID();
    await request(app).post("/api/sync/operations").set("Authorization", `Bearer ${org.token}`).send({
      operation_id: randomUUID(), operation_type: "create", entity_id: firstId, entity_type: "door_leaf",
      opening_id: opening.id, device_id: deviceId, base_server_revision: null, schema_version: 3,
      app_version: "phase-2-test", protocol_version: 1, payload: { leaf_role: "single", material: "Steel" },
    });
    const conflict = await request(app).post("/api/sync/operations").set("Authorization", `Bearer ${org.token}`).send({
      operation_id: randomUUID(), operation_type: "create", entity_id: randomUUID(), entity_type: "door_leaf",
      opening_id: opening.id, device_id: deviceId, base_server_revision: null, schema_version: 3,
      app_version: "phase-2-test", protocol_version: 1, payload: { leaf_role: "single", material: "Wood" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: "permanent_entity_identity_conflict", entity_id: firstId });
  });

  it("rejects cross-organization service-event attribution", async () => {
    const owner = await signupTestOrg("Service owner");
    const outsider = await signupTestOrg("Unrelated provider");
    const { buildingId } = await createPortfolioHierarchy(owner.token);
    const opening = await createTestOpening(owner.token, buildingId);
    const response = await request(app).post("/api/sync/operations").set("Authorization", `Bearer ${owner.token}`).send({
      operation_id: randomUUID(), operation_type: "create", entity_id: randomUUID(), entity_type: "service_event",
      opening_id: opening.id, device_id: deviceId, base_server_revision: null, schema_version: 3,
      app_version: "phase-2-test", protocol_version: 1,
      payload: { event_date: "2026-09-19", work_performed: "Adjusted closer", performed_by_org_id: outsider.organizationId },
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("service_provider_organization_forbidden");
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

  it("retains a private photo and a retryable tombstone when object deletion fails", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const user = await pool.query("SELECT id FROM users WHERE email=$1", [org.email]);
    const id = randomUUID();
    const key = buildPrivatePhotoStorageKey(org.organizationId, opening.id, id, "image/jpeg");
    await pool.query(`INSERT INTO photos
      (id,opening_id,organization_id,related_entity_type,related_entity_id,storage_url,storage_object_key,
       media_type,uploaded_by_user_id,upload_state,revision)
      VALUES ($1,$2,$3,'opening',$2,$4,$5,'photo',$6,'verified',1)`,
    [id, opening.id, org.organizationId, `private:${key}`, key, user.rows[0].id]);
    const envKeys = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
    envKeys.forEach((name) => delete process.env[name]);
    const first = await request(app).delete(`/api/photos/${id}`).set("Authorization", `Bearer ${org.token}`);
    const retry = await request(app).delete(`/api/photos/${id}`).set("Authorization", `Bearer ${org.token}`);
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect((await pool.query("SELECT 1 FROM photos WHERE id=$1", [id])).rows).toHaveLength(1);
    const job = await pool.query("SELECT * FROM photo_deletion_jobs WHERE photo_id=$1", [id]);
    expect(job.rows[0].status).toBe("retry_wait");
    expect(job.rows[0].attempt_count).toBe(2);
    expect(job.rows[0].storage_object_key).toBe(key);
    await pool.query("UPDATE photo_deletion_jobs SET last_attempt_at=now() - interval '2 minutes' WHERE photo_id=$1", [id]);
    const processed = await processPhotoDeletionJobs({
      deletePrivateObject: async (objectKey) => { expect(objectKey).toBe(key); },
    });
    expect(processed).toEqual({ claimed: 1, finalized: 1, retrying: 0 });
    expect((await pool.query("SELECT 1 FROM photos WHERE id=$1", [id])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM photo_deletion_jobs WHERE photo_id=$1", [id])).rows).toHaveLength(0);
    const audit = await pool.query("SELECT * FROM audit_log WHERE action='Finalized private photo deletion' AND user_id=$1", [user.rows[0].id]);
    expect(audit.rows).toHaveLength(1);
  });
});
