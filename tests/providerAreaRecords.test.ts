import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { Client } from "pg";
import { app, signupTestOrg, createTestOpening } from "./helpers";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/opening_intel_test";

const MARICOPA = "04013";
const HARRIS = "48201";

async function signupProvider() {
  const email = `provider-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await request(app).post("/api/auth/signup").send({
    organization_name: `Provider ${Date.now()}`,
    org_type: "service_partner",
    email,
    password: "testpassword123",
    full_name: "Provider Admin",
  });
  if (res.status !== 201) throw new Error(`provider signup failed: ${res.status}`);
  return { token: res.body.token as string, organizationId: res.body.organizationId as string };
}

async function invite(adminToken: string, role: string) {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "password12345";
  const created = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, password, full_name: `Test ${role}`, role });
  const login = await request(app).post("/api/auth/login").send({ email, password });
  return { token: login.body.token as string, userId: created.body.id as string };
}

async function portfolioId(token: string) {
  const res = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${token}`);
  return res.body[0].id as string;
}

// Two facilities assigned to one provider company. The technician's branch
// covers only the first, so the second is out of their area.
async function areaFixture() {
  const customer = await signupTestOrg("Customer");
  const provider = await signupProvider();
  const tech = await invite(provider.token, "technician");
  const portfolio = await portfolioId(customer.token);

  async function site(name: string, state: string, county: string) {
    const property = await request(app)
      .post("/api/portfolio/properties")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ portfolio_id: portfolio, name, state_code: state, county_fips: county, property_type: "multifamily" });
    const building = await request(app)
      .post("/api/portfolio/buildings")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ property_id: property.body.id, name: `${name} Building` });
    const opening = await createTestOpening(customer.token, building.body.id, { fire_rated: true });
    return { propertyId: property.body.id as string, openingId: opening.id as string };
  }

  const inside = await site("Inside Yard", "AZ", MARICOPA);
  const outside = await site("Outside Yard", "TX", HARRIS);

  const insideBranch = await request(app)
    .post("/api/provider/branches")
    .set("Authorization", `Bearer ${provider.token}`)
    .send({ name: "Inside" });
  const outsideBranch = await request(app)
    .post("/api/provider/branches")
    .set("Authorization", `Bearer ${provider.token}`)
    .send({ name: "Outside" });
  await request(app)
    .post(`/api/provider/branches/${insideBranch.body.id}/areas`)
    .set("Authorization", `Bearer ${provider.token}`)
    .send({ state_code: "AZ", county_fips: MARICOPA });
  await request(app)
    .post(`/api/provider/branches/${outsideBranch.body.id}/areas`)
    .set("Authorization", `Bearer ${provider.token}`)
    .send({ state_code: "TX", county_fips: HARRIS });
  await request(app)
    .put(`/api/provider/technicians/${tech.userId}/branch`)
    .set("Authorization", `Bearer ${provider.token}`)
    .send({ branch_id: insideBranch.body.id });

  for (const [siteRow, branchId] of [
    [inside, insideBranch.body.id],
    [outside, outsideBranch.body.id],
  ] as const) {
    const assigned = await request(app)
      .post("/api/provider/assignments")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({
        property_id: siteRow.propertyId,
        provider_organization_id: provider.organizationId,
        provider_branch_id: branchId,
      });
    if (assigned.status !== 201) throw new Error(`assignment failed: ${assigned.status} ${JSON.stringify(assigned.body)}`);
  }

  return { customer, provider, tech, inside, outside };
}

describe("provider area rules on records", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    try {
      const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'oi_rls_tester'");
      if (existing.rows.length === 0) {
        await admin.query("CREATE ROLE oi_rls_tester NOLOGIN NOSUPERUSER NOBYPASSRLS");
      }
      await admin.query(`
        GRANT USAGE ON SCHEMA public, oi_private TO oi_rls_tester;
        GRANT SELECT, INSERT, UPDATE, DELETE ON documents, maintenance_schedules, work_orders TO oi_rls_tester;
      `);
    } finally {
      await admin.end();
    }
  });

  it("a technician only sees and updates work orders inside their area", async () => {
    const { customer, provider, tech, inside, outside } = await areaFixture();
    const insideOrder = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ opening_id: inside.openingId, title: "Inside task" });
    const outsideOrder = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ opening_id: outside.openingId, title: "Outside task" });
    expect(insideOrder.status).toBe(201);

    const list = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${tech.token}`);
    const ids = list.body.map((row: { id: string }) => row.id);
    expect(ids).toContain(insideOrder.body.id);
    expect(ids).not.toContain(outsideOrder.body.id);

    const hidden = await request(app).get(`/api/work-orders/${outsideOrder.body.id}`).set("Authorization", `Bearer ${tech.token}`);
    expect(hidden.status).toBe(404);

    const blocked = await request(app)
      .post(`/api/work-orders/${outsideOrder.body.id}/status`)
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ status: "in_progress" });
    expect(blocked.status).toBe(404);

    const assigned = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ opening_id: inside.openingId, title: "Tech task", assigned_to_user_id: tech.userId });
    expect(assigned.status).toBe(201);
    const updated = await request(app)
      .post(`/api/work-orders/${assigned.body.id}/status`)
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ status: "in_progress" });
    expect(updated.status).toBe(200);

    const refused = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ opening_id: outside.openingId, title: "Should be refused" });
    // The Houston branch covers this facility, so the provider company may
    // create the order. The technician still cannot see it.
    expect(refused.status).toBe(201);
    const stillHidden = await request(app).get(`/api/work-orders/${refused.body.id}`).set("Authorization", `Bearer ${tech.token}`);
    expect(stillHidden.status).toBe(404);
  });

  it("a technician only reaches documents inside their area", async () => {
    const { customer, tech, inside, outside } = await areaFixture();
    const insideDoc = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        property_id: inside.propertyId,
        document_type: "insurance",
        title: "Inside policy",
        storage_url: "https://example-bucket.s3.amazonaws.com/inside.pdf",
      });
    const outsideDoc = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        opening_id: outside.openingId,
        document_type: "warranty",
        title: "Outside warranty",
        storage_url: "https://example-bucket.s3.amazonaws.com/outside.pdf",
      });

    const byProperty = await request(app)
      .get(`/api/documents/by-property/${inside.propertyId}`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(byProperty.status).toBe(200);
    expect(byProperty.body.map((row: { id: string }) => row.id)).toContain(insideDoc.body.id);

    const hiddenProperty = await request(app)
      .get(`/api/documents/by-property/${outside.propertyId}`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(hiddenProperty.status).toBe(403);

    const hiddenOpening = await request(app)
      .get(`/api/documents/by-opening/${outside.openingId}`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(hiddenOpening.status).toBe(403);

    const blocked = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${tech.token}`)
      .send({
        property_id: outside.propertyId,
        document_type: "other",
        title: "Should be refused",
        storage_url: "https://example-bucket.s3.amazonaws.com/refused.pdf",
      });
    expect(blocked.status).toBe(403);

    const allowed = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${tech.token}`)
      .send({
        opening_id: inside.openingId,
        document_type: "inspection_report",
        title: "Inside report",
        storage_url: "https://example-bucket.s3.amazonaws.com/report.pdf",
      });
    expect(allowed.status).toBe(201);

    const removed = await request(app)
      .delete(`/api/documents/${outsideDoc.body.id}`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(removed.status).toBe(404);
  });

  it("a technician only sees maintenance schedules inside their area", async () => {
    const { customer, tech, inside, outside } = await areaFixture();
    const insideSchedule = await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ opening_id: inside.openingId, title: "Inside quarterly", interval_unit: "months", interval_count: 3 });
    const outsideSchedule = await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ opening_id: outside.openingId, title: "Outside quarterly", interval_unit: "months", interval_count: 3 });

    const list = await request(app).get("/api/maintenance-schedules").set("Authorization", `Bearer ${tech.token}`);
    const ids = list.body.map((row: { id: string }) => row.id);
    expect(ids).toContain(insideSchedule.body.id);
    expect(ids).not.toContain(outsideSchedule.body.id);

    const patch = await request(app)
      .patch(`/api/maintenance-schedules/${outsideSchedule.body.id}`)
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ title: "Still the customer's schedule" });
    expect(patch.status).toBe(200);
  });

  it("a technician only downloads a compliance PDF for a facility inside their area", async () => {
    const { tech, inside, outside } = await areaFixture();

    const allowed = await request(app)
      .get(`/api/export/compliance-report.pdf?property_id=${inside.propertyId}`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.slice(0, 4).toString()).toBe("%PDF");

    const refused = await request(app)
      .get(`/api/export/compliance-report.pdf?property_id=${outside.propertyId}`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(refused.status).toBe(403);
  });

  it("row-level security hides out-of-area work orders, documents, and schedules", async () => {
    const { customer, tech, inside, outside } = await areaFixture();
    const workOrder = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ opening_id: inside.openingId, title: "Visible order" });
    const hiddenOrder = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ opening_id: outside.openingId, title: "Hidden order" });
    await request(app).post("/api/documents").set("Authorization", `Bearer ${customer.token}`).send({
      property_id: inside.propertyId,
      document_type: "other",
      title: "Visible doc",
      storage_url: "https://example-bucket.s3.amazonaws.com/visible.pdf",
    });
    await request(app).post("/api/documents").set("Authorization", `Bearer ${customer.token}`).send({
      property_id: outside.propertyId,
      document_type: "other",
      title: "Hidden doc",
      storage_url: "https://example-bucket.s3.amazonaws.com/hidden.pdf",
    });
    await request(app).post("/api/maintenance-schedules").set("Authorization", `Bearer ${customer.token}`).send({
      opening_id: inside.openingId, title: "Visible schedule", interval_unit: "years", interval_count: 1,
    });
    await request(app).post("/api/maintenance-schedules").set("Authorization", `Bearer ${customer.token}`).send({
      opening_id: outside.openingId, title: "Hidden schedule", interval_unit: "years", interval_count: 1,
    });

    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE oi_rls_tester");
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [tech.userId]);

      const orders = await client.query(
        "SELECT id FROM work_orders WHERE id = ANY($1::uuid[])",
        [[workOrder.body.id, hiddenOrder.body.id]]
      );
      expect(orders.rows.map((row) => row.id)).toEqual([workOrder.body.id]);

      const docs = await client.query(
        "SELECT title FROM documents WHERE title IN ('Visible doc', 'Hidden doc') ORDER BY title"
      );
      expect(docs.rows.map((row) => row.title)).toEqual(["Visible doc"]);

      const schedules = await client.query(
        "SELECT title FROM maintenance_schedules WHERE title IN ('Visible schedule', 'Hidden schedule') ORDER BY title"
      );
      expect(schedules.rows.map((row) => row.title)).toEqual(["Visible schedule"]);

      await expect(
        client.query(
          `INSERT INTO work_orders (opening_id, title, created_by_user_id)
           VALUES ($1, 'Out of area', $2)`,
          [outside.openingId, tech.userId]
        )
      ).rejects.toThrow(/row-level security/i);

      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });
});
