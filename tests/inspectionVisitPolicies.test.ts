import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { pool } from "../src/db/pool";
import { app, createPortfolioHierarchy, createTestOpening, signupTestOrg } from "./helpers";
import { passingFireDoorFields } from "./nfpa80Fixture";

const VISIT_MIGRATIONS = [
  "migrations/20261109170000_inspection_visits.sql",
  "migrations/20261109173000_inspection_visit_official_pdf.sql",
  "migrations/20261109190000_inspection_visits_policies.sql",
];

it("gives oi_pr2_api policies when inspection_visits enables row-level security", async () => {
  const chain = VISIT_MIGRATIONS.map((path) => readFileSync(path, "utf8")).join("\n");
  expect(chain).toContain("ALTER TABLE inspection_visits ENABLE ROW LEVEL SECURITY");
  expect(readFileSync(VISIT_MIGRATIONS[0], "utf8")).not.toContain("CREATE POLICY");
  expect(readFileSync(VISIT_MIGRATIONS[2], "utf8")).toContain("CREATE POLICY oi_pr2_api_select");
  expect(readFileSync(VISIT_MIGRATIONS[2], "utf8")).toContain("CREATE POLICY oi_pr2_api_insert");
  expect(readFileSync(VISIT_MIGRATIONS[2], "utf8")).toContain("CREATE POLICY oi_pr2_api_update");
  expect(chain).not.toContain("CREATE TABLE inspection_events");

  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN CREATE ROLE oi_pr2_api NOLOGIN; END IF; END $$");
  await pool.query("ALTER ROLE oi_pr2_api NOBYPASSRLS");
  await pool.query(readFileSync("migrations/20261108171000_fire_door_api_policies.sql", "utf8"));
  await pool.query(readFileSync(VISIT_MIGRATIONS[2], "utf8"));

  const bypass = await pool.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'oi_pr2_api'");
  expect(bypass.rows[0].rolbypassrls).toBe(false);
  const policies = await pool.query(
    `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inspection_visits' AND 'oi_pr2_api' = ANY (roles)`,
  );
  expect(policies.rows.map((row) => row.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  const events = await pool.query(
    `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inspection_events' AND policyname IN ('oi_pr2_api_select', 'oi_pr2_api_update')`,
  );
  expect(events.rows.map((row) => row.cmd).sort()).toEqual(["SELECT", "UPDATE"]);

  const org = await signupTestOrg("Visit policies");
  const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
  const door = await createTestOpening(org.token, buildingId, { opening_code: "POL-1", fire_rated: true });
  const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
    opening_id: door.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", ...passingFireDoorFields(),
  });
  expect(created.status).toBe(201);
  const user = await pool.query("SELECT id FROM users WHERE organization_id = $1 LIMIT 1", [org.organizationId]);
  const visitId = randomUUID();

  const blocked = await pool.connect();
  try {
    await blocked.query("BEGIN");
    await blocked.query("DROP POLICY oi_pr2_api_insert ON inspection_visits");
    await blocked.query("SET LOCAL ROLE oi_pr2_api");
    await expect(blocked.query(
      `INSERT INTO inspection_visits (id, organization_id, property_id, inspector_user_id) VALUES ($1,$2,$3,$4)`,
      [visitId, org.organizationId, propertyId, user.rows[0].id],
    )).rejects.toMatchObject({ code: "42501" });
  } finally {
    await blocked.query("ROLLBACK").catch(() => {});
    blocked.release();
  }

  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("SET LOCAL ROLE oi_pr2_api");
    const inserted = await writer.query(
      `INSERT INTO inspection_visits (id, organization_id, property_id, inspector_user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [visitId, org.organizationId, propertyId, user.rows[0].id],
    );
    expect(inserted.rowCount).toBe(1);
    const seen = await writer.query("SELECT id FROM inspection_visits WHERE id = $1", [visitId]);
    expect(seen.rowCount).toBe(1);
    const updated = await writer.query("UPDATE inspection_visits SET status = 'finished' WHERE id = $1 RETURNING id", [visitId]);
    expect(updated.rowCount).toBe(1);
    const linked = await writer.query("UPDATE inspection_events SET visit_id = $1 WHERE id = $2 RETURNING visit_id", [visitId, created.body.id]);
    expect(linked.rows[0].visit_id).toBe(visitId);
  } finally {
    await writer.query("ROLLBACK").catch(() => {});
    writer.release();
  }
});
