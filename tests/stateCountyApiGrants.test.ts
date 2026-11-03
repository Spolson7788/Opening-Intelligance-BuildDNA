import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { pool } from "../src/db/pool";

// The hosted API is oi_pr2_api, not the table owner. This test gives that role
// only the privileges earlier migrations already defined, then uses the new
// state/county grants to edit a facility, assign a provider, and read records.
async function baselineApiRole(client: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) {
  await client.query(`
    GRANT SELECT, INSERT, UPDATE ON
      openings, work_orders, documents, buildings, portfolios, users, organizations,
      company_branches, facility_provider_assignments
    TO oi_pr2_api
  `);
  // Location writes stay column-scoped in the state/county grant. Insert is a
  // pre-existing facility privilege; this does not grant table-level UPDATE.
  await client.query(`GRANT INSERT ON properties TO oi_pr2_api`);
  await client.query(`GRANT SELECT (share_provider_service_history) ON properties TO oi_pr2_api`);
  for (const table of ["openings", "work_orders", "documents", "buildings", "portfolios", "users", "organizations", "properties"]) {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' AND policyname = 'test_api_read') THEN
          CREATE POLICY test_api_read ON public.${table} FOR SELECT TO oi_pr2_api USING (true);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' AND policyname = 'test_api_insert') THEN
          CREATE POLICY test_api_insert ON public.${table} FOR INSERT TO oi_pr2_api WITH CHECK (true);
        END IF;
      END $$
    `);
  }
}

it("oi_pr2_api can edit a facility, assign a provider, and read records", async () => {
  const owner = await signupTestOrg("Owner");
  const provider = await signupTestOrg("Provider");
  const site = await createPortfolioHierarchy(owner.token);
  const opening = await createTestOpening(owner.token, site.buildingId, { fire_rated: true });
  const workOrder = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${owner.token}`).send({
    opening_id: opening.id, title: "Closer check",
  });
  expect(workOrder.status).toBe(201);
  const document = await request(app).post("/api/documents").set("Authorization", `Bearer ${owner.token}`).send({
    opening_id: opening.id, document_type: "warranty", title: "Warranty", storage_url: "https://example.invalid/warranty.pdf",
  });
  expect(document.status).toBe(201);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
    await baselineApiRole(client);
    await client.query("SET LOCAL ROLE oi_pr2_api");

    const edited = await client.query(
      `UPDATE properties SET state_code = $1, county_fips = $2, state = COALESCE($1, state) WHERE id = $3
       RETURNING id, name, state, state_code, county_fips`,
      ["AZ", "04013", site.propertyId]
    );
    expect(edited.rows[0]).toEqual({
      id: site.propertyId, name: "Test Property", state: "AZ", state_code: "AZ", county_fips: "04013",
    });

    await client.query("SAVEPOINT name_update");
    let nameDenied = false;
    try {
      await client.query(`UPDATE properties SET name = 'Nope' WHERE id = $1`, [site.propertyId]);
    } catch (error: unknown) {
      nameDenied = (error as { code?: string }).code === "42501";
      await client.query("ROLLBACK TO SAVEPOINT name_update");
    }
    expect(nameDenied).toBe(true);

    const addedId = randomUUID();
    await client.query(
      `INSERT INTO properties (id, portfolio_id, name, state, state_code, county_fips, property_type)
       VALUES ($1, $2, 'Added hall', 'TX', 'TX', '48201', 'other')`,
      [addedId, site.portfolioId]
    );
    const added = await client.query(`SELECT state_code, county_fips FROM properties WHERE id = $1`, [addedId]);
    expect(added.rows[0]).toEqual({ state_code: "TX", county_fips: "48201" });

    const branchId = randomUUID();
    await client.query(
      `INSERT INTO company_branches (id, organization_id, name, default_state, is_active)
       VALUES ($1, $2, 'Phoenix', 'AZ', true)`,
      [branchId, provider.organizationId]
    );
    await client.query(
      `INSERT INTO company_branch_areas (branch_id, state_code, county_fips) VALUES ($1, 'AZ', '04013')`,
      [branchId]
    );
    const area = await client.query(`SELECT state_code, county_fips FROM company_branch_areas WHERE branch_id = $1`, [branchId]);
    expect(area.rows[0]).toEqual({ state_code: "AZ", county_fips: "04013" });

    const userId = (await client.query(`SELECT id FROM users WHERE organization_id = $1 LIMIT 1`, [owner.organizationId])).rows[0].id;
    await client.query(
      `INSERT INTO facility_provider_assignments (property_id, provider_organization_id, granted_by_user_id)
       VALUES ($1, $2, $3)`,
      [site.propertyId, provider.organizationId, userId]
    );
    const assignment = await client.query(
      `SELECT property_id FROM facility_provider_assignments WHERE property_id = $1 AND revoked_at IS NULL`,
      [site.propertyId]
    );
    expect(assignment.rows).toHaveLength(1);

    expect((await client.query(`SELECT oi_private.caller_area_allows($1::uuid, $2::uuid) AS allowed`, [userId, site.propertyId])).rows[0].allowed).toBe(true);
    expect((await client.query(`SELECT id FROM openings WHERE id = $1`, [opening.id])).rows[0].id).toBe(opening.id);
    expect((await client.query(`SELECT id FROM work_orders WHERE id = $1`, [workOrder.body.id])).rows[0].id).toBe(workOrder.body.id);
    expect((await client.query(`SELECT id FROM documents WHERE id = $1`, [document.body.id])).rows[0].id).toBe(document.body.id);
    expect((await client.query(`SELECT code FROM us_states WHERE code = 'AZ'`)).rows[0].code).toBe("AZ");
    expect((await client.query(`SELECT fips FROM us_counties WHERE fips = '04013'`)).rows[0].fips).toBe("04013");

    const techArea = await client.query(
      `INSERT INTO technician_areas (user_id, state_code, county_fips) VALUES ($1, 'AZ', '04013') RETURNING id`,
      [userId]
    );
    await client.query(`DELETE FROM technician_areas WHERE id = $1`, [techArea.rows[0].id]);
    expect((await client.query(`SELECT id FROM technician_areas WHERE user_id = $1`, [userId])).rows).toHaveLength(0);

    await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
});
