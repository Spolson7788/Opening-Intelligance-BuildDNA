import { it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

const MARICOPA = "04013";
const HARRIS = "48201";

async function addTech(token: string) {
  const email = `tech-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const created = await request(app).post("/api/members").set("Authorization", `Bearer ${token}`).send({
    email, full_name: "Terry Tech", role: "technician", temporary_password: "testpassword123", is_test_account: true,
  });
  if (created.status !== 201) throw new Error(`member ${created.status} ${JSON.stringify(created.body)}`);
  const login = await request(app).post("/api/auth/login").send({ email, password: "testpassword123" });
  return { token: login.body.token as string, userId: created.body.id as string };
}

async function located(token: string, state: string, county: string) {
  const site = await createPortfolioHierarchy(token);
  const opening = await createTestOpening(token, site.buildingId, { fire_rated: true });
  const placed = await request(app).patch(`/api/geo/facilities/${site.propertyId}`).set("Authorization", `Bearer ${token}`).send({ state_code: state, county_fips: county });
  if (placed.status !== 200) throw new Error(`location ${placed.status} ${JSON.stringify(placed.body)}`);
  return { ...site, openingId: opening.id as string };
}

it("a technician only reaches work orders inside their county", async () => {
  const org = await signupTestOrg();
  const inside = await located(org.token, "AZ", MARICOPA);
  const outside = await located(org.token, "TX", HARRIS);
  const tech = await addTech(org.token);
  await request(app).post(`/api/geo/technicians/${tech.userId}/areas`).set("Authorization", `Bearer ${org.token}`).send({ state_code: "AZ", county_fips: MARICOPA });
  const insideOrder = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`).send({ opening_id: inside.openingId, title: "Inside", assigned_to_user_id: tech.userId });
  const outsideOrder = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`).send({ opening_id: outside.openingId, title: "Outside" });
  const list = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${tech.token}`);
  const ids = list.body.map((row: { id: string }) => row.id);
  expect(ids).toContain(insideOrder.body.id);
  expect(ids).not.toContain(outsideOrder.body.id);
  expect((await request(app).get(`/api/work-orders/${outsideOrder.body.id}`).set("Authorization", `Bearer ${tech.token}`)).status).toBe(404);
  expect((await request(app).post(`/api/work-orders/${insideOrder.body.id}/status`).set("Authorization", `Bearer ${tech.token}`).send({ status: "in_progress" })).status).toBe(200);
  expect((await request(app).post(`/api/work-orders/${outsideOrder.body.id}/status`).set("Authorization", `Bearer ${tech.token}`).send({ status: "in_progress" })).status).toBe(404);
});

it("a technician only reaches documents inside their county", async () => {
  const org = await signupTestOrg();
  const inside = await located(org.token, "AZ", MARICOPA);
  const outside = await located(org.token, "TX", HARRIS);
  const tech = await addTech(org.token);
  await request(app).post(`/api/geo/technicians/${tech.userId}/areas`).set("Authorization", `Bearer ${org.token}`).send({ state_code: "AZ", county_fips: MARICOPA });
  const doc = await request(app).post("/api/documents").set("Authorization", `Bearer ${org.token}`).send({
    property_id: inside.propertyId, document_type: "insurance", title: "Inside policy", storage_url: "https://example.invalid/inside.pdf",
  });
  await request(app).post("/api/documents").set("Authorization", `Bearer ${org.token}`).send({
    opening_id: outside.openingId, document_type: "warranty", title: "Outside warranty", storage_url: "https://example.invalid/outside.pdf",
  });
  const seen = await request(app).get(`/api/documents/by-property/${inside.propertyId}`).set("Authorization", `Bearer ${tech.token}`);
  expect(seen.status).toBe(200);
  expect(seen.body.map((row: { id: string }) => row.id)).toContain(doc.body.id);
  expect((await request(app).get(`/api/documents/by-property/${outside.propertyId}`).set("Authorization", `Bearer ${tech.token}`)).status).toBe(403);
  expect((await request(app).get(`/api/documents/by-opening/${outside.openingId}`).set("Authorization", `Bearer ${tech.token}`)).status).toBe(403);
  expect((await request(app).post("/api/documents").set("Authorization", `Bearer ${tech.token}`).send({
    property_id: outside.propertyId, document_type: "other", title: "Nope", storage_url: "https://example.invalid/nope.pdf",
  })).status).toBe(403);
  expect((await request(app).post("/api/documents").set("Authorization", `Bearer ${tech.token}`).send({
    opening_id: inside.openingId, document_type: "inspection_report", title: "Yes", storage_url: "https://example.invalid/yes.pdf",
  })).status).toBe(201);
});

it("a technician only sees maintenance schedules inside their county", async () => {
  const org = await signupTestOrg();
  const inside = await located(org.token, "AZ", MARICOPA);
  const outside = await located(org.token, "TX", HARRIS);
  const tech = await addTech(org.token);
  await request(app).post(`/api/geo/technicians/${tech.userId}/areas`).set("Authorization", `Bearer ${org.token}`).send({ state_code: "AZ", county_fips: MARICOPA });
  const insideSchedule = await request(app).post("/api/maintenance-schedules").set("Authorization", `Bearer ${org.token}`).send({
    opening_id: inside.openingId, title: "Inside quarterly", interval_unit: "months", interval_count: 3,
  });
  const outsideSchedule = await request(app).post("/api/maintenance-schedules").set("Authorization", `Bearer ${org.token}`).send({
    opening_id: outside.openingId, title: "Outside quarterly", interval_unit: "months", interval_count: 3,
  });
  const list = await request(app).get("/api/maintenance-schedules").set("Authorization", `Bearer ${tech.token}`);
  const ids = list.body.map((row: { id: string }) => row.id);
  expect(ids).toContain(insideSchedule.body.id);
  expect(ids).not.toContain(outsideSchedule.body.id);
});

it("a technician only downloads a compliance PDF inside their county", async () => {
  const org = await signupTestOrg();
  const inside = await located(org.token, "AZ", MARICOPA);
  const outside = await located(org.token, "TX", HARRIS);
  const tech = await addTech(org.token);
  await request(app).post(`/api/geo/technicians/${tech.userId}/areas`).set("Authorization", `Bearer ${org.token}`).send({ state_code: "AZ", county_fips: MARICOPA });
  const allowed = await request(app).get(`/api/export/compliance-report.pdf?property_id=${inside.propertyId}`).set("Authorization", `Bearer ${tech.token}`);
  expect(allowed.status).toBe(200);
  expect(allowed.body.slice(0, 4).toString()).toBe("%PDF");
  expect((await request(app).get(`/api/export/compliance-report.pdf?property_id=${outside.propertyId}`).set("Authorization", `Bearer ${tech.token}`)).status).toBe(403);
});

it("a provider with no declared areas can still be assigned", async () => {
  const customer = await signupTestOrg("Customer");
  const provider = await signupTestOrg("Provider");
  const site = await located(customer.token, "AZ", MARICOPA);
  const assigned = await request(app).put(`/api/provider-assignments/${site.propertyId}/${provider.organizationId}`).set("Authorization", `Bearer ${customer.token}`).send({ active: true });
  expect(assigned.status).toBe(200);
});
