import { describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";

function auth(token: string) { return { Authorization: `Bearer ${token}` }; }

async function structure(token: string, openingId: string, pair = true) {
  const frame = await request(app).put(`/api/openings/${openingId}/frame`).set(auth(token)).send({ material: "Hollow Metal", condition: "good" });
  expect(frame.status).toBe(200);
  const roles = pair ? ["active", "inactive"] : ["single"];
  const leaves: any[] = [];
  for (const leaf_role of roles) {
    const leaf = await request(app).post(`/api/openings/${openingId}/door-leaves`).set(auth(token)).send({ leaf_role, material: "Steel", condition: "good" });
    expect(leaf.status).toBe(201);
    leaves.push(leaf.body);
  }
  return { frame: frame.body, leaves };
}

async function hardware(token: string, openingId: string, body: Record<string, unknown>) {
  return request(app).post("/api/hardware").set(auth(token)).send({
    opening_id: openingId,
    component_type: "closer",
    manufacturer: "Cal-Royal",
    model_number: "CR441",
    review_state: "reviewed",
    ...body,
  });
}

describe("paired-opening data contract — twelve acceptance checks", () => {
  it("1. stores multiple hinges on one single-door leaf", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "single" });
    const { leaves } = await structure(org.token, opening.id, false);
    for (const position_label of ["top", "middle", "bottom"]) {
      const r = await hardware(org.token, opening.id, { component_type: "hinge", mounting_scope: "door_leaf", door_leaf_id: leaves[0].id, position_label });
      expect(r.status).toBe(201);
    }
    const detail = await request(app).get(`/api/openings/${opening.id}`).set(auth(org.token));
    expect(detail.body.hardware_components).toHaveLength(3);
  });

  it("2. stores the same closer model independently on both leaves", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "pair" });
    const { leaves } = await structure(org.token, opening.id);
    const rows = await Promise.all(leaves.map((leaf) => hardware(org.token, opening.id, { mounting_scope: "door_leaf", door_leaf_id: leaf.id })));
    expect(new Set(rows.map((r) => r.body.id)).size).toBe(2);
  });

  it("3. stores the same exit-device model independently on both leaves", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "pair" });
    const { leaves } = await structure(org.token, opening.id);
    for (const leaf of leaves) {
      const r = await hardware(org.token, opening.id, { component_type: "exit_device", model_number: "AF7700", mounting_scope: "door_leaf", door_leaf_id: leaf.id });
      expect(r.status).toBe(201);
    }
  });

  it("4. preserves different conditions for identical products", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "pair" });
    const { leaves } = await structure(org.token, opening.id);
    const good = await hardware(org.token, opening.id, { mounting_scope: "door_leaf", door_leaf_id: leaves[0].id, condition: "good" });
    const worn = await hardware(org.token, opening.id, { mounting_scope: "door_leaf", door_leaf_id: leaves[1].id, condition: "worn" });
    expect([good.body.condition, worn.body.condition]).toEqual(["good", "worn"]);
  });

  it("5. links photos separately to frame, leaf, and component", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "single" });
    const { frame, leaves } = await structure(org.token, opening.id, false);
    const part = await hardware(org.token, opening.id, { mounting_scope: "door_leaf", door_leaf_id: leaves[0].id });
    const targets = [{ frame_id: frame.id }, { door_leaf_id: leaves[0].id }, { hardware_component_id: part.body.id }];
    for (const [i, target] of targets.entries()) {
      const r = await request(app).post("/api/photos").set(auth(org.token)).send({ opening_id: opening.id, storage_url: `https://example.test/${i}.jpg`, content_type: "image/jpeg", ...target });
      expect(r.status).toBe(201);
    }
    const detail = await request(app).get(`/api/openings/${opening.id}`).set(auth(org.token));
    expect(detail.body.photos).toHaveLength(3);
  });

  it("6. never overwrites a second same-class component", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const first = await hardware(org.token, opening.id, { position_label: "first" });
    const second = await hardware(org.token, opening.id, { position_label: "second" });
    expect(first.body.id).not.toBe(second.body.id);
    const list = await request(app).get(`/api/hardware/by-opening/${opening.id}`).set(auth(org.token));
    expect(list.body).toHaveLength(2);
  });

  it("7. reloads hierarchy and persistent completion", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "pair" });
    await structure(org.token, opening.id); await hardware(org.token, opening.id, { condition: "good" });
    const complete = await request(app).post(`/api/openings/${opening.id}/complete`).set(auth(org.token));
    expect(complete.status).toBe(200);
    const reload = await request(app).get(`/api/openings/${opening.id}`).set(auth(org.token));
    expect(reload.body.completion_state).toBe("complete");
    expect(reload.body.door_leaves).toHaveLength(2);
  });

  it("8. returns distinct opening, leaf, component, and eligible counts", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "pair" });
    const { leaves } = await structure(org.token, opening.id);
    await hardware(org.token, opening.id, { mounting_scope: "door_leaf", door_leaf_id: leaves[0].id, condition: "good", identity_status: "established" });
    await hardware(org.token, opening.id, { mounting_scope: "door_leaf", door_leaf_id: leaves[1].id, condition: "worn", identity_status: "established", replacement_required: true });
    await request(app).post(`/api/openings/${opening.id}/complete`).set(auth(org.token));
    const detail = await request(app).get(`/api/openings/${opening.id}`).set(auth(org.token));
    const purchasing = await request(app).get(`/api/openings/${opening.id}/purchasing-eligibility`).set(auth(org.token));
    expect({ openings: 1, leaves: detail.body.door_leaves.length, components: detail.body.hardware_components.length, eligible: purchasing.body.decisions.filter((d: any) => d.eligible).length }).toEqual({ openings: 1, leaves: 2, components: 2, eligible: 1 });
  });

  it("9. blocks completion until frame, required leaves, and review are complete", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "pair" });
    await hardware(org.token, opening.id, { review_state: "pending" });
    const blocked = await request(app).post(`/api/openings/${opening.id}/complete`).set(auth(org.token));
    expect(blocked.status).toBe(409);
    expect(blocked.body.missing).toEqual(expect.arrayContaining(["frame", "active_and_inactive_leaves", "hardware_review"]));
  });

  it("10. applies identity, condition, review, and whole-opening purchasing gates", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_configuration: "single" });
    await structure(org.token, opening.id, false);
    const unresolved = await hardware(org.token, opening.id, { condition: "worn", identity_status: "unresolved", replacement_required: true });
    const serviceable = await hardware(org.token, opening.id, { component_type: "hinge", condition: "good", identity_status: "established", replacement_required: false });
    await request(app).post(`/api/openings/${opening.id}/complete`).set(auth(org.token));
    const result = await request(app).get(`/api/openings/${opening.id}/purchasing-eligibility`).set(auth(org.token));
    const byId = Object.fromEntries(result.body.decisions.map((d: any) => [d.component_id, d]));
    expect(byId[unresolved.body.id].reasons).toContain("identity_unresolved");
    expect(byId[serviceable.body.id].reasons).toContain("replacement_not_required");
  });

  it("11. makes component and photo retry idempotent", async () => {
    const org = await signupTestOrg(); const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentOp = randomUUID();
    const a = await hardware(org.token, opening.id, { client_operation_id: componentOp });
    const b = await hardware(org.token, opening.id, { client_operation_id: componentOp });
    expect(b.body.id).toBe(a.body.id);
    const photoOp = randomUUID();
    const payload = { opening_id: opening.id, storage_url: "https://example.test/retry.jpg", content_type: "image/jpeg", client_operation_id: photoOp };
    const p1 = await request(app).post("/api/photos").set(auth(org.token)).send(payload);
    const p2 = await request(app).post("/api/photos").set(auth(org.token)).send(payload);
    expect(p2.body.id).toBe(p1.body.id);
  });

  it("12. denies cross-tenant hierarchy, component, photo, and completion access", async () => {
    const owner = await signupTestOrg("Owner"); const outsider = await signupTestOrg("Outsider");
    const { buildingId } = await createPortfolioHierarchy(owner.token);
    const opening = await createTestOpening(owner.token, buildingId, { opening_configuration: "pair" });
    const denied = await Promise.all([
      request(app).put(`/api/openings/${opening.id}/frame`).set(auth(outsider.token)).send({ material: "Steel" }),
      request(app).post(`/api/openings/${opening.id}/door-leaves`).set(auth(outsider.token)).send({ leaf_role: "active" }),
      hardware(outsider.token, opening.id, {}),
      request(app).post("/api/photos").set(auth(outsider.token)).send({ opening_id: opening.id, storage_url: "https://example.test/x.jpg", content_type: "image/jpeg" }),
      request(app).post(`/api/openings/${opening.id}/complete`).set(auth(outsider.token)),
    ]);
    expect(denied.map((r) => r.status)).toEqual([404, 404, 403, 403, 404]);
  });
});
