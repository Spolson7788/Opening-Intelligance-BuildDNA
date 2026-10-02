import { describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { splitServiceHistory, componentLabel } from "../field-app/src/lib/serviceHistory";

// A paired opening: one frame, an active and an inactive leaf, one closer on each leaf.
async function pairedOpening(token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const { buildingId } = await createPortfolioHierarchy(token);
  const opening = await createTestOpening(token, buildingId, { opening_configuration: "pair" });
  await request(app).put(`/api/openings/${opening.id}/frame`).set(auth).send({ material: "Steel", condition: "good" });
  const active = await request(app).post(`/api/openings/${opening.id}/door-leaves`).set(auth).send({ leaf_role: "active", condition: "good" });
  const inactive = await request(app).post(`/api/openings/${opening.id}/door-leaves`).set(auth).send({ leaf_role: "inactive", condition: "good" });
  const closer = async (leafId: string) => (await request(app).post("/api/hardware").set(auth).send({
    opening_id: opening.id, component_type: "closer", manufacturer: "Synthetic", model_number: "QA-CL",
    mounting_scope: "door_leaf", door_leaf_id: leafId })).body;
  return { opening, auth, activeCloser: await closer(active.body.id), inactiveCloser: await closer(inactive.body.id) };
}

describe("separate service histories for each component", () => {
  it("records events per closer and at opening level, and reads them back separately", async () => {
    const org = await signupTestOrg();
    const { opening, auth, activeCloser, inactiveCloser } = await pairedOpening(org.token);
    expect(activeCloser.id).toBeTruthy(); expect(inactiveCloser.id).toBeTruthy();
    const post = (body: Record<string, unknown>) => request(app).post("/api/events/service-events").set(auth)
      .send({ opening_id: opening.id, event_date: "2026-10-02", ...body });
    const e1 = await post({ work_performed: "E1 active closer adjusted", hardware_component_id: activeCloser.id });
    const e2 = await post({ work_performed: "E2 inactive closer adjusted", hardware_component_id: inactiveCloser.id });
    const e0 = await post({ work_performed: "E0 whole opening inspected" });
    expect([e1.status, e2.status, e0.status]).toEqual([201, 201, 201]);

    const read = await request(app).get(`/api/openings/${opening.id}`).set(auth);
    const byId = Object.fromEntries(read.body.service_events.map((e: any) => [e.id, e.hardware_component_id]));
    expect(byId[e1.body.id]).toBe(activeCloser.id);
    expect(byId[e2.body.id]).toBe(inactiveCloser.id);
    expect(byId[e0.body.id]).toBeNull();

    const history = splitServiceHistory(read.body);
    expect(history.byComponent.get(activeCloser.id)!.map((e) => e.id)).toEqual([e1.body.id]);
    expect(history.byComponent.get(inactiveCloser.id)!.map((e) => e.id)).toEqual([e2.body.id]);
    expect(history.openingLevel.map((e) => e.id)).toEqual([e0.body.id]);
    expect(history.unmatched).toEqual([]);
    expect(componentLabel(activeCloser, read.body)).toBe("Closer · active leaf · Synthetic QA-CL");
    expect(componentLabel(inactiveCloser, read.body)).toBe("Closer · inactive leaf · Synthetic QA-CL");
  });

  it("rejects a component of another opening on the direct and the sync route", async () => {
    const org = await signupTestOrg();
    const first = await pairedOpening(org.token);
    const second = await pairedOpening(org.token);
    const direct = await request(app).post("/api/events/service-events").set(first.auth).send({
      opening_id: first.opening.id, event_date: "2026-10-02", work_performed: "wrong component", hardware_component_id: second.activeCloser.id });
    expect(direct.status).toBe(409);
    expect(direct.body.error).toBe("component_not_in_opening");
    const queued = await request(app).post("/api/sync/operations").set(first.auth).send({
      operation_id: randomUUID(), entity_id: randomUUID(), entity_type: "service_event", operation_type: "create",
      opening_id: first.opening.id, device_id: randomUUID(), base_server_revision: null, schema_version: 3, app_version: "test", protocol_version: 1,
      payload: { event_date: "2026-10-02", work_performed: "wrong component", hardware_component_id: second.activeCloser.id } });
    expect(queued.status).toBe(409);
    expect(queued.body.error).toBe("component_not_in_opening");
    const read = await request(app).get(`/api/openings/${first.opening.id}`).set(first.auth);
    expect(read.body.service_events).toEqual([]);
  });

  it("does not show one company's component events to another company", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const a = await pairedOpening(orgA.token);
    await request(app).post("/api/events/service-events").set(a.auth).send({
      opening_id: a.opening.id, event_date: "2026-10-02", work_performed: "A only", hardware_component_id: a.activeCloser.id });
    const bAuth = { Authorization: `Bearer ${orgB.token}` };
    expect((await request(app).get(`/api/openings/${a.opening.id}`).set(bAuth)).status).toBe(404);
    const write = await request(app).post("/api/events/service-events").set(bAuth).send({
      opening_id: a.opening.id, event_date: "2026-10-02", work_performed: "B write", hardware_component_id: a.activeCloser.id });
    expect(write.status).toBe(403);
  });
});
