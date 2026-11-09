import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function member(adminToken: string, role: string) {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  const created = await request(app).post("/api/auth/register").set(auth(adminToken)).send({ email, password: "password12345", full_name: role, role });
  expect(created.status).toBe(201);
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

function queued(openingId: string, entityType: "service_event" | "inspection_event", payload: Record<string, unknown>) {
  return {
    operation_id: randomUUID(), operation_type: "create", entity_id: randomUUID(), entity_type: entityType,
    opening_id: openingId, device_id: randomUUID(), base_server_revision: null, schema_version: 3,
    app_version: "field-dashboard-sync", protocol_version: 1, payload,
  };
}

it("keeps field writes on the shared record and limits who can open the dashboard", async () => {
  const customer = await signupTestOrg("Synthetic customer");
  const outsider = await signupTestOrg("Synthetic other customer");
  const provider = await request(app).post("/api/auth/signup").send({
    organization_name: `Synthetic provider ${Date.now()}`, org_type: "service_partner",
    email: `provider-${Date.now()}@example.invalid`, password: "password12345", full_name: "Provider admin",
  });
  expect(provider.status).toBe(201);
  const unassigned = await request(app).post("/api/auth/signup").send({
    organization_name: `Synthetic unassigned ${Date.now()}`, org_type: "service_partner",
    email: `unassigned-${Date.now()}@example.invalid`, password: "password12345", full_name: "Unassigned admin",
  });
  expect(unassigned.status).toBe(201);
  const facility = await createPortfolioHierarchy(customer.token);
  const opening = await createTestOpening(customer.token, facility.buildingId);
  const technician = await member(customer.token, "technician");
  const inspector = await member(customer.token, "inspector");
  const manager = await member(customer.token, "facilities_manager");
  const providerTech = await member(provider.body.token, "technician");
  const strangerTech = await member(unassigned.body.token, "technician");

  const component = {
    operation_id: randomUUID(), entity_id: randomUUID(), opening_id: opening.id, device_id: randomUUID(),
    base_server_revision: null, schema_version: 3, app_version: "field-dashboard-sync", protocol_version: 1,
    payload: { component_type: "closer", mounting_scope: "opening", condition: "worn", model_number: "QA-CLOSER" },
  };
  expect((await request(app).post("/api/sync/components").set(auth(technician)).send(component)).status).toBe(201);
  const field = await request(app).get("/api/openings/" + opening.id).set(auth(technician));
  expect(field.status).toBe(200);
  const part = field.body.hardware_components.find((row: { id: string }) => row.id === component.entity_id);
  const saved = await request(app).patch("/api/hardware/" + part.id).set(auth(technician)).send({ condition: "good", expected_revision: Number(part.revision) });
  expect(saved.status).toBe(200);
  const stale = await request(app).patch("/api/hardware/" + part.id).set(auth(technician)).send({ condition: "failed", expected_revision: Number(part.revision) });
  expect(stale.status).toBe(409);
  expect(stale.body.error).toBe("revision_conflict");
  const service = queued(opening.id, "service_event", { event_date: "2026-11-08", work_performed: "Synthetic technician service", hardware_component_id: part.id });
  expect((await request(app).post("/api/sync/operations").set(auth(technician)).send(service)).status).toBe(201);
  const inspection = queued(opening.id, "inspection_event", { event_date: "2026-11-08", inspection_type: "general", passed: true, notes: "Synthetic inspector note" });
  expect((await request(app).post("/api/sync/operations").set(auth(inspector)).send(inspection)).status).toBe(201);
  expect((await request(app).post("/api/sync/components").set(auth(inspector)).send({ ...component, operation_id: randomUUID(), entity_id: randomUUID() })).status).toBe(403);

  const url = "/api/portfolio/facility-dashboard/" + facility.propertyId;
  const access = "/api/portfolio/facility-dashboard-access";
  for (const token of [customer.token, manager]) {
    expect((await request(app).get(access).set(auth(token))).body).toEqual({ allowed: true });
    const dashboard = await request(app).get(url).set(auth(token));
    expect(dashboard.status).toBe(200);
    const row = dashboard.body.openings.find((item: { id: string }) => item.id === opening.id);
    expect(row.hardware_components.find((item: { id: string }) => item.id === part.id).condition).toBe("good");
    expect(row.service_events.map((item: { work_performed: string }) => item.work_performed)).toContain("Synthetic technician service");
    expect(row.inspection_events.map((item: { notes: string }) => item.notes)).toContain("Synthetic inspector note");
  }
  for (const token of [technician, inspector]) {
    expect((await request(app).get(access).set(auth(token))).status).toBe(403);
    const blocked = await request(app).get(url).set(auth(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("facility_dashboard_forbidden");
    expect(blocked.body.openings).toBeUndefined();
    const own = await request(app).get("/api/openings/" + opening.id).set(auth(token));
    expect(own.status).toBe(200);
    expect(own.body.hardware_components.find((item: { id: string }) => item.id === part.id).condition).toBe("good");
  }
  expect((await request(app).get(url).set(auth(outsider.token))).status).toBe(404);
  expect((await request(app).get("/api/openings/" + opening.id).set(auth(outsider.token))).status).toBe(404);

  expect((await request(app).put(`/api/provider-assignments/${facility.propertyId}/${provider.body.organizationId}`).set(auth(customer.token)).send({ active: true })).status).toBe(200);
  const providerService = queued(opening.id, "service_event", { event_date: "2026-11-09", work_performed: "Synthetic assigned provider service" });
  expect((await request(app).post("/api/sync/operations").set(auth(providerTech)).send(providerService)).status).toBe(201);
  expect((await request(app).post("/api/sync/operations").set(auth(strangerTech)).send(queued(opening.id, "service_event", { event_date: "2026-11-09", work_performed: "Synthetic unassigned service" }))).status).toBe(403);
  const afterAssignment = await request(app).get(url).set(auth(manager));
  expect(afterAssignment.body.openings.find((item: { id: string }) => item.id === opening.id).service_events.map((item: { work_performed: string }) => item.work_performed)).toEqual(expect.arrayContaining(["Synthetic technician service", "Synthetic assigned provider service"]));
  expect((await request(app).get(access).set(auth(providerTech))).status).toBe(403);
  expect((await request(app).get(url).set(auth(provider.body.token))).body.error).toBe("facility_dashboard_forbidden");
  expect((await request(app).get("/api/openings/" + opening.id).set(auth(providerTech))).status).toBe(200);
  expect((await request(app).get("/api/openings/" + opening.id).set(auth(strangerTech))).status).toBe(404);
});
