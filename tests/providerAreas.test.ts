import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { Client } from "pg";
import { app, signupTestOrg, createTestOpening } from "./helpers";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/opening_intel_test";

const MARICOPA = "04013";
const PIMA = "04019";
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
  if (res.status !== 201) throw new Error(`provider signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token as string, organizationId: res.body.organizationId as string, email };
}

async function invite(adminToken: string, role: string) {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "password12345";
  const created = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, password, full_name: `Test ${role}`, role });
  if (created.status !== 201) throw new Error(`invite failed: ${created.status} ${JSON.stringify(created.body)}`);
  const login = await request(app).post("/api/auth/login").send({ email, password });
  return { token: login.body.token as string, userId: created.body.id as string };
}

async function portfolioId(token: string) {
  const res = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${token}`);
  return res.body[0].id as string;
}

async function facility(token: string, name: string, stateCode: string, countyFips: string) {
  const property = await request(app)
    .post("/api/portfolio/properties")
    .set("Authorization", `Bearer ${token}`)
    .send({
      portfolio_id: await portfolioId(token),
      name,
      state_code: stateCode,
      county_fips: countyFips,
      property_type: "multifamily",
    });
  if (property.status !== 201) throw new Error(`property failed: ${property.status} ${JSON.stringify(property.body)}`);
  const building = await request(app)
    .post("/api/portfolio/buildings")
    .set("Authorization", `Bearer ${token}`)
    .send({ property_id: property.body.id, name: `${name} Building` });
  const opening = await createTestOpening(token, building.body.id);
  return { propertyId: property.body.id as string, openingId: opening.id as string };
}

describe("state and county areas", () => {
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
        GRANT SELECT ON
          us_states, us_counties, properties, buildings, openings,
          service_events, inspection_events, hardware_components, photos,
          work_orders, provider_branches, provider_branch_areas,
          technician_areas, facility_provider_assignments
        TO oi_rls_tester;
        GRANT INSERT ON service_events TO oi_rls_tester;
      `);
    } finally {
      await admin.end();
    }
  });

  it("loads every state and backfills a legacy state name without inventing a county", async () => {
    const states = await request(app).get("/api/locations/states").set("Authorization", `Bearer ${(await signupTestOrg()).token}`);
    expect(states.status).toBe(200);
    expect(states.body).toHaveLength(51);
    expect(states.body.some((state: { code: string }) => state.code === "AZ")).toBe(true);

    const org = await signupTestOrg();
    const created = await request(app)
      .post("/api/portfolio/properties")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ portfolio_id: await portfolioId(org.token), name: "Legacy Phoenix", state: "Arizona", property_type: "other" });
    expect(created.status).toBe(201);
    expect(created.body.state_code).toBe("AZ");
    expect(created.body.county_fips).toBeNull();

    const counties = await request(app)
      .get("/api/locations/counties?state_code=AZ")
      .set("Authorization", `Bearer ${org.token}`);
    expect(counties.status).toBe(200);
    expect(counties.body.some((county: { fips: string }) => county.fips === MARICOPA)).toBe(true);

    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const counts = await client.query("SELECT (SELECT count(*) FROM us_counties) AS counties");
      expect(Number(counts.rows[0].counties)).toBe(3143);
      await client.query("SET session_replication_role = replica");
      await client.query(
        `INSERT INTO properties (portfolio_id, name, state)
         VALUES ($1, 'Legacy Texas', 'texas')`,
        [await portfolioId(org.token)]
      );
      await client.query("SET session_replication_role = origin");
      const filled = await client.query("SELECT oi_private.backfill_property_state_codes() AS n");
      expect(Number(filled.rows[0].n)).toBeGreaterThan(0);
      const row = await client.query("SELECT state_code, county_fips FROM properties WHERE name = 'Legacy Texas'");
      expect(row.rows[0].state_code).toBe("TX");
      expect(row.rows[0].county_fips).toBeNull();
    } finally {
      await client.end();
    }
  });

  it("rejects a county that is not in the facility's state", async () => {
    const org = await signupTestOrg();
    const res = await request(app)
      .post("/api/portfolio/properties")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        portfolio_id: await portfolioId(org.token),
        name: "Wrong county",
        state_code: "AZ",
        county_fips: HARRIS,
        property_type: "other",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("county_not_in_state");
  });

  it("refuses an out-of-area provider assignment and hides that facility from the technician", async () => {
    const customer = await signupTestOrg("Customer");
    const phoenix = await facility(customer.token, "Phoenix Yard", "AZ", MARICOPA);
    const houston = await facility(customer.token, "Houston Yard", "TX", HARRIS);
    const provider = await signupProvider();
    const tech = await invite(provider.token, "technician");

    const phoenixBranch = await request(app)
      .post("/api/provider/branches")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ name: "Phoenix" });
    expect(phoenixBranch.status).toBe(201);
    const houstonBranch = await request(app)
      .post("/api/provider/branches")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ name: "Houston" });

    const phoenixArea = await request(app)
      .post(`/api/provider/branches/${phoenixBranch.body.id}/areas`)
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ state_code: "AZ", county_fips: MARICOPA });
    expect(phoenixArea.status).toBe(201);
    await request(app)
      .post(`/api/provider/branches/${houstonBranch.body.id}/areas`)
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ state_code: "TX", county_fips: HARRIS });

    const placed = await request(app)
      .put(`/api/provider/technicians/${tech.userId}/branch`)
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ branch_id: phoenixBranch.body.id });
    expect(placed.status).toBe(200);

    const inArea = await request(app)
      .post("/api/provider/assignments")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({
        property_id: phoenix.propertyId,
        provider_organization_id: provider.organizationId,
        provider_branch_id: phoenixBranch.body.id,
      });
    expect(inArea.status).toBe(201);

    const outOfArea = await request(app)
      .post("/api/provider/assignments")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({
        property_id: houston.propertyId,
        provider_organization_id: provider.organizationId,
        provider_branch_id: phoenixBranch.body.id,
      });
    expect(outOfArea.status).toBe(409);
    expect(outOfArea.body.error).toBe("out_of_area");

    // The same refusal holds for a direct write, not only the HTTP route.
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO facility_provider_assignments
             (property_id, provider_organization_id, provider_branch_id)
           VALUES ($1, $2, $3)`,
          [houston.propertyId, provider.organizationId, phoenixBranch.body.id]
        )
      ).rejects.toThrow(/out_of_area/);
    } finally {
      await client.end();
    }

    // Houston is assigned to the company through a different branch. The
    // Phoenix technician still must not see it or work it.
    const houstonAssignment = await request(app)
      .post("/api/provider/assignments")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({
        property_id: houston.propertyId,
        provider_organization_id: provider.organizationId,
        provider_branch_id: houstonBranch.body.id,
      });
    expect(houstonAssignment.status).toBe(201);

    const visible = await request(app).get("/api/facilities").set("Authorization", `Bearer ${tech.token}`);
    expect(visible.status).toBe(200);
    const visibleIds = visible.body.map((row: { id: string }) => row.id);
    expect(visibleIds).toContain(phoenix.propertyId);
    expect(visibleIds).not.toContain(houston.propertyId);

    const hiddenOpening = await request(app)
      .get(`/api/openings/${houston.openingId}`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(hiddenOpening.status).toBe(404);

    const hiddenOpenings = await request(app)
      .get(`/api/facilities/${houston.propertyId}/openings`)
      .set("Authorization", `Bearer ${tech.token}`);
    expect(hiddenOpenings.status).toBe(404);

    const blockedWork = await request(app)
      .post("/api/events/service-events")
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ opening_id: houston.openingId, event_date: "2026-04-01", work_performed: "Should be refused" });
    expect(blockedWork.status).toBe(403);

    const allowedWork = await request(app)
      .post("/api/events/service-events")
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ opening_id: phoenix.openingId, event_date: "2026-04-01", work_performed: "Adjusted closer" });
    expect(allowedWork.status).toBe(201);

    const filtered = await request(app)
      .get("/api/openings?state_code=AZ&county_fips=04013")
      .set("Authorization", `Bearer ${customer.token}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.map((row: { id: string }) => row.id)).toContain(phoenix.openingId);
    expect(filtered.body.map((row: { id: string }) => row.id)).not.toContain(houston.openingId);
    expect(filtered.body.find((row: { id: string }) => row.id === phoenix.openingId).county_name).toBe("Maricopa County");

    // Database role, the path Supabase RLS enforces. The table owner used by
    // the API bypasses RLS; this role does not.
    const rls = new Client({ connectionString: DATABASE_URL });
    await rls.connect();
    try {
      await rls.query("BEGIN");
      await rls.query("SET LOCAL ROLE oi_rls_tester");
      await rls.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [tech.userId]);
      const properties = await rls.query("SELECT id FROM properties WHERE id = ANY($1::uuid[])", [
        [phoenix.propertyId, houston.propertyId],
      ]);
      expect(properties.rows.map((row) => row.id)).toEqual([phoenix.propertyId]);
      const openings = await rls.query("SELECT id FROM openings WHERE id = ANY($1::uuid[])", [
        [phoenix.openingId, houston.openingId],
      ]);
      expect(openings.rows.map((row) => row.id)).toEqual([phoenix.openingId]);
      await expect(
        rls.query(
          `INSERT INTO service_events (opening_id, event_date, work_performed)
           VALUES ($1, '2026-04-02', 'Out of area')`,
          [houston.openingId]
        )
      ).rejects.toThrow(/row-level security/i);
      await rls.query("ROLLBACK");
    } finally {
      await rls.end();
    }
  });

  it("uses a technician's own area when one is set, instead of the branch area", async () => {
    const customer = await signupTestOrg("Customer Override");
    const maricopa = await facility(customer.token, "Override Phoenix", "AZ", MARICOPA);
    const pima = await facility(customer.token, "Override Tucson", "AZ", PIMA);
    const provider = await signupProvider();
    const tech = await invite(provider.token, "technician");

    const branch = await request(app)
      .post("/api/provider/branches")
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ name: "Arizona" });
    await request(app)
      .post(`/api/provider/branches/${branch.body.id}/areas`)
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ state_code: "AZ" });
    await request(app)
      .put(`/api/provider/technicians/${tech.userId}/branch`)
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ branch_id: branch.body.id });
    for (const propertyId of [maricopa.propertyId, pima.propertyId]) {
      const assigned = await request(app)
        .post("/api/provider/assignments")
        .set("Authorization", `Bearer ${provider.token}`)
        .send({
          property_id: propertyId,
          provider_organization_id: provider.organizationId,
          provider_branch_id: branch.body.id,
        });
      expect(assigned.status).toBe(201);
    }

    const before = await request(app).get("/api/facilities").set("Authorization", `Bearer ${tech.token}`);
    expect(before.body.map((row: { id: string }) => row.id).sort()).toEqual(
      [maricopa.propertyId, pima.propertyId].sort()
    );

    const override = await request(app)
      .post(`/api/provider/technicians/${tech.userId}/areas`)
      .set("Authorization", `Bearer ${provider.token}`)
      .send({ state_code: "AZ", county_fips: PIMA });
    expect(override.status).toBe(201);

    const after = await request(app).get("/api/facilities").set("Authorization", `Bearer ${tech.token}`);
    expect(after.body.map((row: { id: string }) => row.id)).toEqual([pima.propertyId]);

    const moved = await request(app)
      .patch(`/api/portfolio/properties/${pima.propertyId}/location`)
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ state_code: "TX", county_fips: HARRIS });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe("assignment_would_be_out_of_area");
  });

  it("still lets a customer technician work their own facility with no provider area", async () => {
    const org = await signupTestOrg("In house");
    const site = await facility(org.token, "Home Office", "AZ", MARICOPA);
    const tech = await invite(org.token, "technician");
    const res = await request(app)
      .post("/api/events/service-events")
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ opening_id: site.openingId, event_date: "2026-04-03", work_performed: "In house" });
    expect(res.status).toBe(201);
    const list = await request(app).get("/api/facilities").set("Authorization", `Bearer ${tech.token}`);
    expect(list.body.map((row: { id: string }) => row.id)).toContain(site.propertyId);
  });
});
