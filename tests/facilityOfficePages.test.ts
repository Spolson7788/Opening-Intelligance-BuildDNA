import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";

const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("../src/services/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/storage")>();
  return {
    ...actual,
    putPrivateBytes: async (key: string, bytes: Uint8Array) => {
      const copy = Buffer.from(bytes);
      storage.objects.set(key, copy);
      return { etag: "office", sha256: createHash("sha256").update(copy).digest("hex"), byteSize: copy.length };
    },
    getObjectBytes: async (key: string) => {
      const found = storage.objects.get(key);
      if (!found) throw new Error("object_missing");
      return found;
    },
  };
});

import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { failingFireDoorFields, passingFireDoorFields } from "./nfpa80Fixture";
import { pool } from "../src/db/pool";
import { customerMayOpenFacilityDashboard, mayOpenFacilityDashboard } from "../src/services/facilityDashboardAccess";
import { readFileSync } from "node:fs";

afterEach(() => storage.objects.clear());

async function reuseInternalAdmin() {
  const org = await pool.query("SELECT id FROM organizations WHERE org_type='internal' LIMIT 1");
  expect(org.rows.length).toBe(1);
  const email = `internal-staff-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  const hash = await bcrypt.hash("password12345", 4);
  const user = await pool.query(
    "INSERT INTO users (organization_id, email, full_name, role, password_hash) VALUES ($1,$2,'Internal staff','admin',$3) RETURNING id",
    [org.rows[0].id, email, hash],
  );
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  expect(login.status).toBe(200);
  return { token: login.body.token as string, organizationId: org.rows[0].id as string, email };
}

async function account(orgType: "customer" | "service_partner" | "internal", role = "admin") {
  const stamp = `${orgType}-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const signup = await request(app).post("/api/auth/signup").send({
    organization_name: `Synthetic ${stamp}`, org_type: orgType, email: `${stamp}@example.invalid`, password: "password12345", full_name: "Synthetic",
  });
  if (orgType === "internal" && signup.status === 409) return reuseInternalAdmin();
  expect(signup.status).toBe(201);
  if (role === "admin") return { token: signup.body.token as string, organizationId: signup.body.organizationId as string, email: `${stamp}@example.invalid` };
  const email = `${role}-${stamp}@example.invalid`;
  await request(app).post("/api/auth/register").set("Authorization", `Bearer ${signup.body.token}`).send({ email, password: "password12345", full_name: role, role });
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  expect(login.status).toBe(200);
  return { token: login.body.token as string, organizationId: signup.body.organizationId as string, email };
}

it("lets verified staff open only a customer office they already belong to", () => {
  expect(readFileSync("src/services/facilityDashboardAccess.ts", "utf8")).not.toContain("is_platform_staff");
  expect(customerMayOpenFacilityDashboard("internal", "admin")).toBe(false);
  expect(customerMayOpenFacilityDashboard("customer", "admin")).toBe(true);
  expect(mayOpenFacilityDashboard({ orgType: "customer", role: "facilities_manager", staff: false })).toBe(true);
  expect(mayOpenFacilityDashboard({ orgType: "customer", role: "technician", staff: false })).toBe(false);
  expect(mayOpenFacilityDashboard({ orgType: "customer", role: "inspector", staff: false })).toBe(false);
  expect(mayOpenFacilityDashboard({ orgType: "internal", role: "admin", staff: true, mfaVerified: true })).toBe(false);
  expect(mayOpenFacilityDashboard({ orgType: "customer", role: "technician", staff: true, mfaVerified: true })).toBe(false);
  expect(mayOpenFacilityDashboard({ orgType: "customer", role: "admin", staff: true, mfaVerified: false })).toBe(false);
  expect(mayOpenFacilityDashboard({ orgType: "customer", role: "admin", staff: true, mfaVerified: true })).toBe(true);
  expect(mayOpenFacilityDashboard({ orgType: "customer", role: "facilities_manager", staff: true, mfaVerified: true })).toBe(true);
  expect(mayOpenFacilityDashboard({ orgType: "service_partner", role: "admin", staff: true, mfaVerified: true })).toBe(false);
});

it("applies the customer office gate to catalog, planning, finance, and history", async () => {
  const admin = await account("customer", "admin");
  const manager = await account("customer", "facilities_manager");
  const technician = await account("customer", "technician");
  const inspector = await account("customer", "inspector");
  const viewer = await account("customer", "viewer");
  const provider = await account("service_partner", "admin");
  const internal = await account("internal", "admin");
  const facility = await createPortfolioHierarchy(admin.token);
  const opening = await createTestOpening(admin.token, facility.buildingId);
  const managerFacility = await createPortfolioHierarchy(manager.token);
  const managerOpening = await createTestOpening(manager.token, managerFacility.buildingId);
  const paths = [
    "/api/commercial/context/" + opening.id,
    "/api/planning/" + opening.id,
    "/api/sandbox-finance/" + opening.id,
    "/api/condition-history/facility/" + opening.id,
  ];
  for (const path of paths) {
    expect((await request(app).get(path).set("Authorization", `Bearer ${admin.token}`)).status).toBe(200);
    const managerPath = path.replace(opening.id, managerOpening.id);
    expect((await request(app).get(managerPath).set("Authorization", `Bearer ${manager.token}`)).status).toBe(200);
    for (const denied of [technician, inspector, viewer, provider, internal]) {
      const response = await request(app).get(path).set("Authorization", `Bearer ${denied.token}`);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "facility_dashboard_forbidden" });
    }
  }
  const other = await account("customer", "admin");
  for (const path of paths) {
    const cross = await request(app).get(path).set("Authorization", `Bearer ${other.token}`);
    expect(cross.status).toBe(404);
    expect(cross.body.openings).toBeUndefined();
    expect(JSON.stringify(cross.body)).not.toContain(opening.id);
  }
});

it("allows verified staff with an office membership and denies staff without one", async () => {
  const customer = await account("customer", "admin");
  const facility = await createPortfolioHierarchy(customer.token);
  const opening = await createTestOpening(customer.token, facility.buildingId);
  const staff = await reuseInternalAdmin();
  const person = await pool.query("SELECT id, session_version FROM users WHERE lower(email)=lower($1)", [staff.email]);
  await pool.query("INSERT INTO platform_staff (user_id, grant_reason) VALUES ($1, 'synthetic office grant')", [person.rows[0].id]);
  const secret = process.env.JWT_SECRET as string;
  const atHome = jwt.sign({ userId: person.rows[0].id, organizationId: staff.organizationId, role: "admin", sessionVersion: Number(person.rows[0].session_version), mfaVerified: true }, secret, { expiresIn: "1h" });
  const homeGate = await request(app).get("/api/portfolio/facility-dashboard-access").set("Authorization", `Bearer ${atHome}`);
  expect(homeGate.status).toBe(403);
  expect(homeGate.body).toEqual({ error: "facility_dashboard_forbidden" });
  await pool.query("INSERT INTO organization_memberships (user_id, organization_id, role, is_active, is_home) VALUES ($1,$2,'admin',true,false)", [person.rows[0].id, customer.organizationId]);
  const asOffice = jwt.sign({ userId: person.rows[0].id, organizationId: customer.organizationId, role: "technician", sessionVersion: Number(person.rows[0].session_version), mfaVerified: true }, secret, { expiresIn: "1h" });
  expect((await request(app).get("/api/portfolio/facility-dashboard-access").set("Authorization", `Bearer ${asOffice}`)).body).toEqual({ allowed: true });
  expect((await request(app).get("/api/portfolio/facility-dashboard/" + facility.propertyId).set("Authorization", `Bearer ${asOffice}`)).status).toBe(200);
  expect((await request(app).get("/api/commercial/context/" + opening.id).set("Authorization", `Bearer ${asOffice}`)).status).toBe(200);
  expect((await request(app).get("/api/planning/" + opening.id).set("Authorization", `Bearer ${asOffice}`)).status).toBe(200);
  const tech = await reuseInternalAdmin();
  const techPerson = await pool.query("SELECT id, session_version FROM users WHERE lower(email)=lower($1)", [tech.email]);
  await pool.query("INSERT INTO platform_staff (user_id, grant_reason) VALUES ($1, 'synthetic tech grant')", [techPerson.rows[0].id]);
  await pool.query("INSERT INTO organization_memberships (user_id, organization_id, role, is_active, is_home) VALUES ($1,$2,'technician',true,false)", [techPerson.rows[0].id, customer.organizationId]);
  const asTech = jwt.sign({ userId: techPerson.rows[0].id, organizationId: customer.organizationId, role: "admin", sessionVersion: Number(techPerson.rows[0].session_version), mfaVerified: true }, secret, { expiresIn: "1h" });
  const techGate = await request(app).get("/api/commercial/context/" + opening.id).set("Authorization", `Bearer ${asTech}`);
  expect(techGate.status).toBe(403);
  expect(techGate.body).toEqual({ error: "facility_dashboard_forbidden" });
  const other = await account("customer", "admin");
  const otherFacility = await createPortfolioHierarchy(other.token);
  const cross = await request(app).get("/api/portfolio/facility-dashboard/" + otherFacility.propertyId).set("Authorization", `Bearer ${asOffice}`);
  expect(cross.status).toBe(404);
  expect(cross.body.openings).toBeUndefined();
});

it("shows facility visits with the stored official PDF and records advised dates only when they exist", async () => {
  const customer = await signupTestOrg("Riverside office");
  const provider = await request(app).post("/api/auth/signup").send({
    organization_name: "Synthetic Provider Co", org_type: "service_partner",
    email: `provider-${Date.now()}@example.invalid`, password: "password12345", full_name: "Pat Inspector",
  });
  expect(provider.status).toBe(201);
  const facility = await createPortfolioHierarchy(customer.token);
  const opening = await createTestOpening(customer.token, facility.buildingId, { opening_code: "SYN-101", fire_rated: true, opening_configuration: "single" });
  const leaf = await request(app).post("/api/openings/" + opening.id + "/door-leaves").set("Authorization", `Bearer ${customer.token}`).send({ leaf_role: "single", condition: "worn" });
  expect(leaf.status).toBe(201);
  const hardware = await request(app).post("/api/hardware").set("Authorization", `Bearer ${customer.token}`).send({
    opening_id: opening.id, component_type: "closer", mounting_scope: "door_leaf", door_leaf_id: leaf.body.id, condition: "worn",
  });
  expect(hardware.status).toBe(201);
  await request(app).put(`/api/provider-assignments/${facility.propertyId}/${provider.body.organizationId}`).set("Authorization", `Bearer ${customer.token}`).send({ active: true });
  const techEmail = `tech-${Date.now()}@example.invalid`;
  await request(app).post("/api/auth/register").set("Authorization", `Bearer ${customer.token}`).send({ email: techEmail, password: "password12345", full_name: "Tech", role: "technician" });
  const tech = await request(app).post("/api/auth/login").send({ email: techEmail, password: "password12345" });
  const user = await pool.query("SELECT id FROM users WHERE lower(email)=lower($1)", [customer.email]);
  const requestId = randomUUID();
  await pool.query(
    `INSERT INTO service_requests (id, opening_id, requesting_organization_id, created_by_user_id, provider_organization_id, symptom, impact, priority, uncertain_target, created_at)
     VALUES ($1,$2,$3,$4,$3,'Closer will not latch','', 'normal', false, '2026-09-01T15:00:00Z')`,
    [requestId, opening.id, customer.organizationId, user.rows[0].id],
  );
  await pool.query("INSERT INTO service_request_targets (request_id, opening_id, hardware_component_id) VALUES ($1,$2,$3)", [requestId, opening.id, hardware.body.id]);
  expect((await request(app).post("/api/events/service-events").set("Authorization", `Bearer ${customer.token}`).send({
    opening_id: opening.id, hardware_component_id: hardware.body.id, event_date: "2026-10-20", work_performed: "Adjusted closer",
  })).status).toBe(201);
  expect((await request(app).post("/api/events/service-events").set("Authorization", `Bearer ${customer.token}`).send({
    opening_id: opening.id, event_date: "2026-08-01", work_performed: "Lubricated hinges",
  })).status).toBe(201);
  const failed = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${customer.token}`).send({
    opening_id: opening.id, event_date: "2026-07-01", inspection_type: "fire_door_nfpa80", ...failingFireDoorFields("Label missing"),
  });
  expect(failed.status).toBe(201);
  const deficiency = await pool.query("SELECT id FROM fire_door_deficiencies WHERE inspection_event_id=$1", [failed.body.id]);
  expect((await request(app).post(`/api/events/fire-door-deficiencies/${deficiency.rows[0].id}/repair`).set("Authorization", `Bearer ${customer.token}`).send({ repair_note: "Label replaced" })).status).toBe(200);

  const visitId = randomUUID();
  const visit = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${provider.body.token}`).send({
    opening_id: opening.id, event_date: "2026-11-09", inspection_type: "fire_door_nfpa80", visit_id: visitId, ...passingFireDoorFields(),
  });
  expect(visit.status).toBe(201);
  const key = `synthetic/visits/${visitId}.pdf`;
  const pdf = Buffer.from("%PDF-1.4\nsynthetic official visit\n%%EOF");
  storage.objects.set(key, pdf);
  await pool.query("UPDATE inspection_visits SET report_storage_key=$2, report_sha256=$3 WHERE id=$1", [visitId, key, createHash("sha256").update(pdf).digest("hex")]);

  const listUrl = `/api/portfolio/facility-dashboard/${facility.propertyId}/inspection-visits`;
  const listed = await request(app).get(listUrl).set("Authorization", `Bearer ${customer.token}`);
  expect(listed.status).toBe(200);
  expect(listed.body.visits).toEqual([expect.objectContaining({
    id: visitId, visit_date: "2026-11-09", inspector_name: "Test Inspector", provider_company: "Synthetic Provider Co",
    inspected: 1, passed: 1, failed: 0, report_stored: true,
  })]);
  const download = await request(app).get(`${listUrl}/${visitId}/report.pdf`).set("Authorization", `Bearer ${customer.token}`).buffer(true);
  expect(download.status).toBe(200);
  expect(download.headers["content-type"]).toMatch(/pdf/);
  expect(download.body.toString()).toContain("synthetic official visit");
  expect((await request(app).get(listUrl).set("Authorization", `Bearer ${tech.body.token}`)).status).toBe(403);
  expect((await request(app).get(listUrl).set("Authorization", `Bearer ${provider.body.token}`)).status).toBe(403);
  const other = await signupTestOrg("Other office");
  expect((await request(app).get(listUrl).set("Authorization", `Bearer ${other.token}`)).status).toBe(404);
  await pool.query("UPDATE inspection_visits SET report_storage_key=NULL WHERE id=$1", [visitId]);
  const missing = await request(app).get(`${listUrl}/${visitId}/report.pdf`).set("Authorization", `Bearer ${customer.token}`);
  expect(missing.status).toBe(404);
  expect(missing.body.error).toBe("official_pdf_not_stored");

  const dashboard = await request(app).get("/api/portfolio/facility-dashboard/" + facility.propertyId).set("Authorization", `Bearer ${customer.token}`);
  expect(dashboard.status).toBe(200);
  const records = dashboard.body.openings[0].work_records;
  const adjusted = records.find((row: { label: string }) => row.label === "Adjusted closer");
  const lubricated = records.find((row: { label: string }) => row.label === "Lubricated hinges");
  const repair = records.find((row: { kind: string }) => row.kind === "repair");
  expect(adjusted).toMatchObject({ kind: "service", performed_on: "2026-10-20", advised_on: "2026-09-01" });
  expect(lubricated).toMatchObject({ kind: "service", performed_on: "2026-08-01", advised_on: null });
  expect(repair.label).toContain("Label replaced");
  expect(repair.advised_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(repair.performed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
