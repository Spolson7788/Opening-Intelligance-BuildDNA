import { describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";
import { buildStorageKey, isStorageKeyInOpeningScope } from "../src/services/storage";

describe("offline synchronization and photograph retention", () => {
  it("preserves client-generated parent IDs for an offline leaf-to-component chain", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "single" });
    const frameId = randomUUID();
    const leafId = randomUUID();
    const frame = await request(app).put(`/api/openings/${opening.id}/frame`).set("Authorization", `Bearer ${org.token}`).send({ id: frameId, material: "Steel" });
    const leaf = await request(app).post(`/api/openings/${opening.id}/door-leaves`).set("Authorization", `Bearer ${org.token}`).send({ id: leafId, leaf_role: "single", material: "Steel" });
    const component = await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id,
      component_type: "closer",
      mounting_scope: "door_leaf",
      door_leaf_id: leafId,
      client_operation_id: randomUUID(),
    });
    expect(frame.body.id).toBe(frameId);
    expect(leaf.body.id).toBe(leafId);
    expect(component.status).toBe(201);
    expect(component.body.door_leaf_id).toBe(leafId);
  });

  it("uses a stable client operation id for retry-safe object keys", () => {
    const operationId = randomUUID();
    const first = buildStorageKey("org-a", "opening-a", "image/jpeg", operationId);
    const retry = buildStorageKey("org-a", "opening-a", "image/jpeg", operationId);
    expect(retry).toBe(first);
    expect(first).toBe(`org/org-a/opening/opening-a/${operationId}.jpg`);
  });

  it("rejects traversal and cross-tenant storage keys", () => {
    expect(isStorageKeyInOpeningScope("org/a/opening/b/photo.jpg", "a", "b")).toBe(true);
    expect(isStorageKeyInOpeningScope("org/other/opening/b/photo.jpg", "a", "b")).toBe(false);
    expect(isStorageKeyInOpeningScope("org/a/opening/b/../other.jpg", "a", "b")).toBe(false);
  });

  it("confirms the same photo operation twice without duplicate records", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const operationId = randomUUID();
    const storageKey = buildStorageKey(org.organizationId, opening.id, "image/jpeg", operationId);
    const payload = {
      opening_id: opening.id,
      storage_key: storageKey,
      content_type: "image/jpeg",
      client_operation_id: operationId,
      related_entity_type: "opening",
    };
    const first = await request(app).post("/api/photos").set("Authorization", `Bearer ${org.token}`).send(payload);
    const retry = await request(app).post("/api/photos").set("Authorization", `Bearer ${org.token}`).send(payload);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.storage_key).toBe(storageKey);
  });

  it("denies confirmation for a storage key outside the authenticated tenant", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const result = await request(app).post("/api/photos").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id,
      storage_key: buildStorageKey("another-org", opening.id, "image/jpeg", randomUUID()),
      content_type: "image/jpeg",
      client_operation_id: randomUUID(),
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("storage_key_outside_opening_scope");
  });
});
