import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app";

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/db/pool", () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));

const app = createApp();
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, "").replace(/uuid_generate_v4\(\)/g, "gen_random_uuid()");
const id: Record<string, string> = {};
const PASS = "synthetic-pass-" + randomUUID().slice(0, 8);
const tok = (user: string, org: string, role: string, sv = 0) =>
  "Bearer " + jwt.sign({ userId: id[user], organizationId: id[org], role, sessionVersion: sv, ...(user === "staff" ? { mfaVerified: true } : {}) }, process.env.JWT_SECRET!);

beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec("CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;");
  for (const name of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) {
    await state.db.exec(fix(readFileSync("migrations/" + name, "utf8")));
  }
  const hash = bcrypt.hashSync(PASS, 4);
  const org = async (key: string, type: string) => {
    id[key] = randomUUID();
    await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)", [id[key], "Synthetic " + key, type]);
  };
  const user = async (key: string, orgKey: string, role: string) => {
    id[key] = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic',$4,$5)", [id[key], id[orgKey], key + "@example.invalid", role, hash]);
  };
  await org("oi", "internal");
  await org("parent", "customer");
  await org("pilot", "customer");
  await org("other", "customer");
  await org("provider", "service_partner");
  await user("staff", "oi", "admin");
  await user("parentAdmin", "parent", "admin");
  await user("tech", "pilot", "technician");
  await user("former", "pilot", "technician");
  await user("otherAdmin", "other", "admin");
  await user("providerAdmin", "provider", "admin");
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic founder')", [id.staff]);
  await state.db.exec(`BEGIN; SELECT set_config('oi.actor_user_id','${id.staff}',true), set_config('oi.reason','synthetic tree',true); UPDATE organizations SET parent_organization_id='${id.parent}' WHERE id='${id.pilot}'; COMMIT;`);
  await sql("INSERT INTO organization_memberships(user_id,organization_id,role,is_active,is_home) VALUES($1,$2,'technician',true,false)", [id.tech, id.other]);
  await sql("UPDATE users SET is_active=false WHERE id=$1", [id.former]);
  const portfolio = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio, id.pilot]);
  id.property = randomUUID();
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [id.property, portfolio]);
  id.building = randomUUID();
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')", [id.building, id.property]);
  id.opening = randomUUID();
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1,$2,$3,$4,'door')", [id.opening, id.building, "SYN-PILOT", "qr-" + id.opening]);
  id.photo = randomUUID();
  await sql("INSERT INTO photos(id,opening_id,related_entity_type,related_entity_id,storage_url) VALUES($1,$2,'opening',$1,'synthetic://pilot-photo')", [id.photo, id.opening]);
  const otherPortfolio = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Other portfolio')", [otherPortfolio, id.other]);
  id.otherProperty = randomUUID();
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Other facility')", [id.otherProperty, otherPortfolio]);
  id.otherBuilding = randomUUID();
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Other building')", [id.otherBuilding, id.otherProperty]);
  id.otherOpening = randomUUID();
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1,$2,$3,$4,'door')", [id.otherOpening, id.otherBuilding, "SYN-OTHER", "qr-" + id.otherOpening]);
  await sql("INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)", [id.property, id.provider, id.tech]);
}, 180000);

afterAll(async () => { await state.db?.close(); });

const staff = () => tok("staff", "oi", "admin");
const counts = async () => (await sql(`SELECT
  (SELECT count(*)::int FROM organizations) organizations,
  (SELECT count(*)::int FROM users) users,
  (SELECT count(*)::int FROM organization_memberships) memberships,
  (SELECT count(*)::int FROM openings) openings,
  (SELECT count(*)::int FROM photos) photos,
  (SELECT count(*)::int FROM facility_provider_assignments) assignments`)).rows[0];

describe("company deactivation", () => {
  it("is staff-only and refuses the OI company", async () => {
    const body = { reason: "pilot ended" };
    expect((await request(app).post(`/api/platform/organizations/${id.pilot}/deactivate`).set("Authorization", tok("otherAdmin", "other", "admin")).send(body)).status).toBe(403);
    expect((await request(app).post(`/api/platform/organizations/${id.oi}/deactivate`).set("Authorization", staff()).send(body)).body.error).toBe("cannot_deactivate_internal_company");
    expect((await request(app).post(`/api/platform/organizations/${id.pilot}/deactivate`).set("Authorization", staff()).send({})).status).toBe(400);
  });

  it("shuts off that company's sign-ins and keeps every row", async () => {
    const before = await counts();
    const version = (await sql("SELECT session_version FROM users WHERE id=$1", [id.tech])).rows[0].session_version;
    const otherVersion = (await sql("SELECT session_version FROM users WHERE id=$1", [id.otherAdmin])).rows[0].session_version;
    const closed = await request(app).post(`/api/platform/organizations/${id.pilot}/deactivate`).set("Authorization", staff()).send({ reason: "pilot ended" });
    expect(closed.status).toBe(200);
    expect(closed.body.memberships_deactivated).toBe(1);
    expect(await counts()).toEqual(before);
    const tech = (await sql("SELECT u.is_active, u.session_version, m.is_active AS member FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=$2 WHERE u.id=$1", [id.tech, id.pilot])).rows[0];
    expect(tech).toMatchObject({ is_active: true, member: false });
    expect(tech.session_version).toBe(version + 1);
    expect((await sql("SELECT is_active FROM organization_memberships WHERE user_id=$1 AND organization_id=$2", [id.tech, id.other])).rows[0].is_active).toBe(true);
    expect((await sql("SELECT is_active FROM users WHERE id=$1", [id.former])).rows[0].is_active).toBe(false);
    expect((await sql("SELECT session_version FROM users WHERE id=$1", [id.otherAdmin])).rows[0].session_version).toBe(otherVersion);
    expect((await sql("SELECT revoked_at FROM facility_provider_assignments WHERE property_id=$1", [id.property])).rows[0].revoked_at).toBeNull();
    const audit = (await sql("SELECT actor_user_id, reason, before_state, after_state FROM platform_audit_events WHERE action='company_deactivated' AND target_org_id=$1", [id.pilot])).rows[0];
    expect(audit.actor_user_id).toBe(id.staff);
    expect(audit.reason).toBe("pilot ended");
    expect(audit.after_state.assignments_unchanged).toBe(true);
    expect((await sql("SELECT count(*)::int n FROM audit_log WHERE organization_id=$1 AND action='company_deactivated' AND user_id=$2", [id.pilot, id.staff])).rows[0].n).toBe(1);

    for (const path of ["/api/openings", "/api/photos/by-opening/" + id.opening, "/api/field-routes/nearby", "/api/events/inspection-visits/" + randomUUID() + "/report.pdf"]) {
      const denied = await request(app).get(path).set("Authorization", tok("tech", "pilot", "technician", version));
      expect(denied.status, path).toBe(403);
      expect(denied.body.error, path).toBe("company_deactivated");
    }
    const fresh = await request(app).post("/api/auth/login").send({ email: "tech@example.invalid", password: PASS });
    expect(fresh.status).toBe(200);
    expect(fresh.body.active_organization_id).toBe(id.other);
    expect(fresh.body.companies.map((c: { organization_id: string }) => c.organization_id)).not.toContain(id.pilot);

    const provider = await request(app).get("/api/openings").set("Authorization", tok("providerAdmin", "provider", "admin"));
    expect(provider.status).toBe(200);
    expect(provider.body.map((row: { id: string }) => row.id)).toContain(id.opening);
    const parentSeesChild = await sql("SELECT organization_id FROM user_authorized_orgs($1) WHERE organization_id=$2", [id.parentAdmin, id.pilot]);
    expect(parentSeesChild.rows).toHaveLength(1);
    const parentOpenings = await request(app).get("/api/openings?scope=tree").set("Authorization", tok("parentAdmin", "parent", "admin"));
    expect(parentOpenings.status).toBe(200);
    expect(parentOpenings.body.map((row: { opening_code: string }) => row.opening_code)).toContain("SYN-PILOT");
    const other = await request(app).get("/api/openings").set("Authorization", tok("otherAdmin", "other", "admin"));
    expect(other.status).toBe(200);
    expect(other.body.map((row: { opening_code: string }) => row.opening_code)).toEqual(["SYN-OTHER"]);
  });

  it("reactivation restores the memberships that were active and leaves the former person off", async () => {
    const restored = await request(app).post(`/api/platform/organizations/${id.pilot}/reactivate`).set("Authorization", staff()).send({ reason: "pilot resumed" });
    expect(restored.status).toBe(200);
    expect(restored.body.memberships_restored).toBe(1);
    expect((await sql("SELECT deactivated_at FROM organizations WHERE id=$1", [id.pilot])).rows[0].deactivated_at).toBeNull();
    expect((await sql("SELECT count(*)::int n FROM organization_deactivation_memberships WHERE organization_id=$1", [id.pilot])).rows[0].n).toBe(0);
    expect((await sql("SELECT is_active FROM organization_memberships WHERE user_id=$1 AND organization_id=$2", [id.tech, id.pilot])).rows[0].is_active).toBe(true);
    expect((await sql("SELECT is_active FROM organization_memberships WHERE user_id=$1 AND organization_id=$2", [id.former, id.pilot])).rows[0].is_active).toBe(false);
    const version = (await sql("SELECT session_version FROM users WHERE id=$1", [id.tech])).rows[0].session_version;
    const openings = await request(app).get("/api/openings").set("Authorization", tok("tech", "pilot", "technician", version));
    expect(openings.status).toBe(200);
    expect(openings.body.map((row: { opening_code: string }) => row.opening_code)).toContain("SYN-PILOT");
    const audit = (await sql("SELECT actor_user_id, reason FROM platform_audit_events WHERE action='company_reactivated' AND target_org_id=$1", [id.pilot])).rows[0];
    expect(audit).toMatchObject({ actor_user_id: id.staff, reason: "pilot resumed" });
  });
});
