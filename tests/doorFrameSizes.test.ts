import { expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

async function fixture(configuration: "single" | "pair" = "single") {
  const org = await signupTestOrg();
  const { buildingId } = await createPortfolioHierarchy(org.token);
  const opening = await createTestOpening(org.token, buildingId, { opening_configuration: configuration });
  return { ...org, opening, auth: { Authorization: `Bearer ${org.token}` } };
}

it("keeps stored frame and leaf sizes when a material-only save omits them", async () => {
  const f = await fixture("pair");
  const frame = await request(app).put(`/api/openings/${f.opening.id}/frame`).set(f.auth).send({ material: "Hollow metal", width_in: 72, height_in: 96 });
  expect(frame.status).toBe(200);
  const leaf = await request(app).post(`/api/openings/${f.opening.id}/door-leaves`).set(f.auth).send({ leaf_role: "active", material: "Wood", width_in: 36, height_in: 84, thickness_in: 1.75 });
  expect(leaf.status).toBe(201);
  const frameSync = await request(app).post("/api/sync/operations").set(f.auth).send({
    operation_id: randomUUID(), operation_type: "update", entity_id: frame.body.id, entity_type: "frame",
    opening_id: f.opening.id, device_id: randomUUID(), base_server_revision: Number(frame.body.revision),
    schema_version: 3, app_version: "size-test", protocol_version: 1, payload: { material: "Aluminum" },
  });
  expect(frameSync.status).toBe(201);
  const leafSync = await request(app).post("/api/sync/operations").set(f.auth).send({
    operation_id: randomUUID(), operation_type: "update", entity_id: leaf.body.id, entity_type: "door_leaf",
    opening_id: f.opening.id, device_id: randomUUID(), base_server_revision: Number(leaf.body.revision),
    schema_version: 3, app_version: "size-test", protocol_version: 1, payload: { leaf_role: "active", material: "Pine" },
  });
  expect(leafSync.status).toBe(201);
  const storedFrame = await pool.query("SELECT material, width_in, height_in FROM opening_frames WHERE id=$1", [frame.body.id]);
  expect(storedFrame.rows[0].material).toBe("Aluminum");
  expect(Number(storedFrame.rows[0].width_in)).toBe(72);
  expect(Number(storedFrame.rows[0].height_in)).toBe(96);
  const storedLeaf = await pool.query("SELECT material, width_in, height_in, thickness_in FROM door_leaves WHERE id=$1", [leaf.body.id]);
  expect(storedLeaf.rows[0].material).toBe("Pine");
  expect(Number(storedLeaf.rows[0].width_in)).toBe(36);
  expect(Number(storedLeaf.rows[0].height_in)).toBe(84);
  expect(Number(storedLeaf.rows[0].thickness_in)).toBe(1.75);
});

it("renames leaf roles without dropping the leaf id that hardware uses", async () => {
  const f = await fixture("pair");
  const active = await request(app).post(`/api/openings/${f.opening.id}/door-leaves`).set(f.auth).send({ leaf_role: "active", width_in: 36 });
  const inactive = await request(app).post(`/api/openings/${f.opening.id}/door-leaves`).set(f.auth).send({ leaf_role: "inactive", width_in: 30 });
  expect(active.status).toBe(201);
  expect(inactive.status).toBe(201);
  const hardware = await request(app).post("/api/hardware").set(f.auth).send({
    opening_id: f.opening.id, component_type: "closer", mounting_scope: "door_leaf", door_leaf_id: active.body.id, condition: "good",
  });
  expect(hardware.status).toBe(201);
  const toSingle = await request(app).post(`/api/openings/${f.opening.id}/configuration`).set(f.auth).send({ opening_configuration: "single" });
  expect(toSingle.status).toBe(200);
  expect(toSingle.body.opening.opening_configuration).toBe("single");
  const kept = toSingle.body.door_leaves.find((leaf: { id: string }) => leaf.id === active.body.id);
  expect(kept.leaf_role).toBe("single");
  expect(toSingle.body.door_leaves.some((leaf: { id: string }) => leaf.id === inactive.body.id)).toBe(true);
  const stillMounted = await pool.query("SELECT door_leaf_id FROM hardware_components WHERE id=$1", [hardware.body.id]);
  expect(stillMounted.rows[0].door_leaf_id).toBe(active.body.id);
  const back = await request(app).post(`/api/openings/${f.opening.id}/configuration`).set(f.auth).send({ opening_configuration: "pair" });
  expect(back.status).toBe(200);
  expect(back.body.door_leaves.find((leaf: { id: string }) => leaf.id === active.body.id).leaf_role).toBe("active");
  expect(back.body.door_leaves.find((leaf: { id: string }) => leaf.id === inactive.body.id).leaf_role).toBe("inactive");
});
