import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../src/db/pool", () => ({ pool: {
  query: (sql: string, values?: unknown[]) => state.db.query(sql, values),
  connect: async () => ({ query: (sql: string, values?: unknown[]) => state.db.query(sql, values), release() {} }),
} }));
import { createOrReplayPhotoReservation } from "../src/routes/photos";

beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec(`CREATE TABLE photo_upload_reservations (
    id serial PRIMARY KEY, organization_id uuid NOT NULL, opening_id uuid NOT NULL,
    photo_id uuid UNIQUE NOT NULL, operation_id uuid NOT NULL, target_type text, target_id uuid,
    storage_object_key text, upload_object_key text, original_filename text, content_type text,
    byte_size bigint, sha256_checksum text, actor_user_id uuid, device_id uuid,
    latitude numeric(9,6), longitude numeric(9,6), expires_at timestamptz,
    status text DEFAULT 'reserved', UNIQUE(organization_id, operation_id));`);
}, 30000);
afterAll(async () => { await state.db?.close(); });

function capture() {
  const opening = randomUUID();
  return { photo_id: randomUUID(), client_operation_id: randomUUID(), opening_id: opening,
    target_type: "opening" as const, target_id: opening, original_filename: "synthetic.png",
    content_type: "image/png", byte_size: 11373, sha256_checksum: "a".repeat(64),
    device_id: randomUUID(), actor_user_id: randomUUID() };
}

describe("reservation coordinate comparison at PostgreSQL storage precision", () => {
  it.each([
    [12.123456789, -45.987654321, "12.123457", "-45.987654"],
    [12.1234565, -12.1234565, "12.123457", "-12.123457"],
    [12.123456499, -12.123456499, "12.123456", "-12.123456"],
    [0.0000005, -0.0000005, "0.000001", "-0.000001"],
    [0.000000499, -0.000000499, "0.000000", "0.000000"],
    [90, -180, "90.000000", "-180.000000"],
  ])("accepts and replays latitude %s longitude %s", async (latitude, longitude, lat, lon) => {
    const org = randomUUID(), input = { ...capture(), latitude, longitude };
    const first = await createOrReplayPhotoReservation(org, input);
    expect(first).toMatchObject({ created: true, reservation: { latitude: lat, longitude: lon } });
    const replay = await createOrReplayPhotoReservation(org, input);
    expect(replay).toMatchObject({ created: false });
    expect(replay.reservation.id).toBe(first.reservation.id);
    const rows = await state.db.query("SELECT count(*)::int AS count FROM photo_upload_reservations WHERE photo_id=$1", [input.photo_id]);
    expect(rows.rows[0].count).toBe(1);
  });

  it("preserves absent coordinates as NULL and distinguishes NULL from zero", async () => {
    const org = randomUUID(), input = capture();
    expect(await createOrReplayPhotoReservation(org, input)).toMatchObject({ created: true, reservation: { latitude: null, longitude: null } });
    expect(await createOrReplayPhotoReservation(org, input)).toMatchObject({ created: false });
    expect(await createOrReplayPhotoReservation(org, { ...input, latitude: 0 })).toEqual({ conflict: "idempotency_key_reused" });
    expect(await createOrReplayPhotoReservation(org, { ...input, longitude: 0 })).toEqual({ conflict: "idempotency_key_reused" });
    const located = { ...capture(), latitude: 0, longitude: 0 };
    await createOrReplayPhotoReservation(org, located);
    expect(await createOrReplayPhotoReservation(org, { ...located, latitude: undefined })).toEqual({ conflict: "idempotency_key_reused" });
  });

  it("accepts only coordinate differences below persisted precision", async () => {
    const org = randomUUID(), input = { ...capture(), latitude: 12.1234561, longitude: -45.1234561 };
    await createOrReplayPhotoReservation(org, input);
    expect(await createOrReplayPhotoReservation(org, { ...input, latitude: 12.1234564 })).toMatchObject({ created: false });
    expect(await createOrReplayPhotoReservation(org, { ...input, latitude: 12.1234565 })).toEqual({ conflict: "idempotency_key_reused" });
    expect(await createOrReplayPhotoReservation(org, { ...input, longitude: -45.1234565 })).toEqual({ conflict: "idempotency_key_reused" });
  });

  it.each([
    ["photo_id", randomUUID()], ["opening_id", randomUUID()], ["target_type", "hardware_component"],
    ["target_id", randomUUID()], ["content_type", "image/jpeg"], ["byte_size", 11374],
    ["sha256_checksum", "b".repeat(64)], ["original_filename", "different.png"],
    ["actor_user_id", randomUUID()], ["device_id", randomUUID()],
  ])("still rejects changed %s", async (field, value) => {
    const org = randomUUID(), input = capture();
    await createOrReplayPhotoReservation(org, input);
    expect(await createOrReplayPhotoReservation(org, { ...input, [field]: value })).toEqual({ conflict: "idempotency_key_reused" });
  });

  it("rejects reusing a photo identity with another operation or organization", async () => {
    const org = randomUUID(), input = capture();
    await createOrReplayPhotoReservation(org, input);
    expect(await createOrReplayPhotoReservation(org, { ...input, client_operation_id: randomUUID() })).toEqual({ conflict: "photo_identity_reused" });
    expect(await createOrReplayPhotoReservation(randomUUID(), input)).toEqual({ conflict: "photo_identity_reused" });
  });
});
