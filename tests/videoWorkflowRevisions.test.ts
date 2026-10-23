import { describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { pool } from "../src/db/pool";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

async function fixture() {
  const org = await signupTestOrg();
  const { buildingId } = await createPortfolioHierarchy(org.token);
  const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "pair" });
  return { ...org, opening, auth: { Authorization: `Bearer ${org.token}` } };
}
describe("video workflow revision prerequisites", () => {
  it("rejects another actor's receipt and cross-opening component targets", async () => {
    const f = await fixture();
    const payload = { opening_id: f.opening.id, component_type: "closer", client_operation_id: randomUUID() };
    expect((await request(app).post('/api/hardware').set(f.auth).send(payload)).status).toBe(201);
    const other = await pool.query("INSERT INTO users(organization_id,email,full_name,role,password_hash) VALUES($1,$2,'Other actor','admin','test-only-no-login') RETURNING id", [f.organizationId, `${randomUUID()}@example.test`]);
    const token = jwt.sign({ userId: other.rows[0].id, organizationId: f.organizationId, role: "admin", sessionVersion: 0 }, process.env.JWT_SECRET!);
    expect((await request(app).post('/api/hardware').set('Authorization', `Bearer ${token}`).send(payload)).status).toBe(409);
    const second = await fixture();
    const leaf = await request(app).post(`/api/openings/${second.opening.id}/door-leaves`).set(second.auth).send({ leaf_role: "active" });
    expect((await request(app).post('/api/hardware').set(f.auth).send({ ...payload, client_operation_id: randomUUID(), mounting_scope: "door_leaf", door_leaf_id: leaf.body.id })).status).toBe(400);
    expect((await request(app).post('/api/hardware').set(second.auth).send(payload)).status).toBe(403);
  });
  it("preserves opposite-leaf closer identities and replays immutable create/update results", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (const leaf_role of ["active", "inactive"]) {
      const leaf = await request(app).post(`/api/openings/${f.opening.id}/door-leaves`).set(f.auth).send({ leaf_role });
      expect(leaf.status).toBe(201);
      const payload = { opening_id: f.opening.id, component_type: "closer", model_number: "CR441", mounting_scope: "door_leaf", door_leaf_id: leaf.body.id, client_operation_id: randomUUID() };
      const created = await request(app).post('/api/hardware').set(f.auth).send(payload);
      expect(created.status).toBe(201); ids.push(created.body.id);
      const replay = await request(app).post('/api/hardware').set(f.auth).send(payload);
      expect(replay.body).toEqual(created.body);
      expect((await request(app).post('/api/hardware').set(f.auth).send({ ...payload, model_number: "changed" })).status).toBe(409);
      const update = { condition: "worn", expected_revision: Number(created.body.revision), client_operation_id: randomUUID() };
      const saved = await request(app).patch(`/api/hardware/${created.body.id}`).set(f.auth).send(update);
      expect(saved.status).toBe(200); expect(Number(saved.body.revision)).toBe(2);
      expect((await request(app).patch(`/api/hardware/${created.body.id}`).set(f.auth).send(update)).body).toEqual(saved.body);
      expect((await request(app).patch(`/api/hardware/${created.body.id}`).set(f.auth).send({ ...update, condition: "failed" })).status).toBe(409);
      const stale = await request(app).patch(`/api/hardware/${created.body.id}`).set(f.auth).send({ expected_revision: 1, condition: "good" });
      expect(stale.status).toBe(409); expect(stale.body.server_revision).toBe(2);
      expect((await request(app).patch(`/api/hardware/${created.body.id}`).set(f.auth).send({ condition: "good" })).status).toBe(409);
    }
    expect(new Set(ids).size).toBe(2);
  });

  for (const entity_type of ["frame", "door_leaf"]) it(`checks ${entity_type} sync revisions and retries`, async () => {
    const f = await fixture();
    const original = { operation_id: randomUUID(), operation_type: "create", entity_id: randomUUID(), entity_type,
      opening_id: f.opening.id, device_id: randomUUID(), base_server_revision: null, schema_version: 3,
      app_version: "revision-test", protocol_version: 1, payload: { ...(entity_type === "door_leaf" ? { leaf_role: "active" } : {}), material: "Steel" } };
    const send = (body: any) => request(app).post('/api/sync/operations').set(f.auth).send(body);
    const created = await send(original); expect(created.status).toBe(201);
    const update = { ...original, operation_id: randomUUID(), operation_type: "update", base_server_revision: 1, payload: { ...original.payload, condition: "worn" } };
    const saved = await send(update); expect(saved.status).toBe(201); expect(Number(saved.body.resulting_server_revision)).toBe(2);
    expect((await send(update)).body.status).toBe('already_applied');
    expect((await send({ ...update, payload: { ...update.payload, condition: "failed" } })).status).toBe(409);
    const stale = await send({ ...update, operation_id: randomUUID() }); expect(stale.status).toBe(409); expect(stale.body.server_revision).toBe(2);
    expect((await send({ ...original, operation_id: randomUUID() })).status).toBe(409);
    expect((await send(original)).body.status).toBe('already_applied');
  });

  it("protects direct structure updates while allowing unchanged legacy retries", async () => {
    const f = await fixture();
    for (const leaf of [false, true]) {
      const send = (body: any) => leaf
        ? request(app).post(`/api/openings/${f.opening.id}/door-leaves`).set(f.auth).send(body)
        : request(app).put(`/api/openings/${f.opening.id}/frame`).set(f.auth).send(body);
      const data = { ...(leaf ? { leaf_role: "active" } : {}), material: "Steel" };
      const created = await send(data); expect(created.status).toBe(leaf ? 201 : 200);
      const replay = await send(data); expect(replay.body.id).toBe(created.body.id); expect(Number(replay.body.revision)).toBe(1);
      expect((await send({ ...data, material: "Wood" })).status).toBe(409);
      const changed = await send({ ...data, expected_revision: 1, material: "Wood" }); expect(Number(changed.body.revision)).toBe(2);
      expect((await send({ ...data, expected_revision: 1 })).status).toBe(409);
    }
  });
});
