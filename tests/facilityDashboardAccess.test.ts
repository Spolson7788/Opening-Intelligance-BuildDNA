import { describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { pool } from "../src/db/pool";
import { customerMayOpenFacilityDashboard } from "../src/services/facilityDashboardAccess";
import { AUTH_CONTEXT_SQL } from "../src/middleware/auth";

async function account(orgType: "customer" | "service_partner" | "internal", role = "admin") {
  const stamp = `${orgType}-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const signup = await request(app).post("/api/auth/signup").send({
    organization_name: `Synthetic ${stamp}`, org_type: orgType, email: `${stamp}@example.invalid`, password: "password12345", full_name: "Synthetic",
  });
  expect(signup.status).toBe(201);
  if (role === "admin") return signup.body.token as string;
  const email = `${role}-${stamp}@example.invalid`;
  await request(app).post("/api/auth/register").set("Authorization", `Bearer ${signup.body.token}`).send({ email, password: "password12345", full_name: role, role });
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

describe("facility dashboard office access", () => {
  it("allows only a customer admin or facilities manager", () => {
    expect(customerMayOpenFacilityDashboard("customer", "admin")).toBe(true);
    expect(customerMayOpenFacilityDashboard("customer", "facilities_manager")).toBe(true);
    for (const role of ["technician", "inspector", "viewer", "unknown", null]) expect(customerMayOpenFacilityDashboard("customer", role)).toBe(false);
    for (const orgType of ["service_partner", "internal", null, ""]) {
      expect(customerMayOpenFacilityDashboard(orgType, "admin")).toBe(false);
      expect(customerMayOpenFacilityDashboard(orgType, "facilities_manager")).toBe(false);
    }
  });

  it("denies field roles and provider or staff companies without returning openings", async () => {
    const customerAdmin = await account("customer", "admin");
    const otherManager = await account("customer", "facilities_manager");
    const technician = await account("customer", "technician");
    const inspector = await account("customer", "inspector");
    const providerAdmin = await account("service_partner", "admin");
    const internalAdmin = await account("internal", "admin");
    const facility = await createPortfolioHierarchy(customerAdmin);
    await createTestOpening(customerAdmin, facility.buildingId);
    const sameEmail = `same-tech-${Date.now()}@example.invalid`;
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${customerAdmin}`).send({ email: sameEmail, password: "password12345", full_name: "Same tech", role: "technician" });
    const sameTech = (await request(app).post("/api/auth/login").send({ email: sameEmail, password: "password12345" })).body.token as string;
    const url = "/api/portfolio/facility-dashboard/" + facility.propertyId;
    const access = "/api/portfolio/facility-dashboard-access";
    expect((await request(app).get(access).set("Authorization", `Bearer ${customerAdmin}`)).body).toEqual({ allowed: true });
    expect((await request(app).get(url).set("Authorization", `Bearer ${customerAdmin}`)).status).toBe(200);
    expect((await request(app).get(access).set("Authorization", `Bearer ${otherManager}`)).body).toEqual({ allowed: true });
    expect((await request(app).get(url).set("Authorization", `Bearer ${otherManager}`)).status).toBe(404);
    for (const token of [technician, inspector, providerAdmin, internalAdmin, sameTech]) {
      const gate = await request(app).get(access).set("Authorization", `Bearer ${token}`);
      expect(gate.status).toBe(403);
      expect(gate.body).toEqual({ error: "facility_dashboard_forbidden" });
      const read = await request(app).get(url).set("Authorization", `Bearer ${token}`);
      expect(read.status).toBe(403);
      expect(read.body.openings).toBeUndefined();
    }
    expect((await request(app).get(url)).status).toBe(401);
    const fieldList = await request(app).get("/api/portfolio/properties").set("Authorization", `Bearer ${sameTech}`);
    expect(fieldList.status).toBe(200);
    expect(fieldList.body.map((row: { id: string }) => row.id)).toContain(facility.propertyId);
    const opening = await createTestOpening(customerAdmin, facility.buildingId);
    const openingRead = await request(app).get("/api/openings/" + opening.id).set("Authorization", `Bearer ${sameTech}`);
    expect(openingRead.status).toBe(200);
    expect(openingRead.body.id).toBe(opening.id);
    expect(readFileSync("field-app/src/pages/ScanPage.tsx", "utf8")).not.toContain("facility-dashboard");
  });

  it("uses the active company after a real company switch", async () => {
    const customer = await signupTestOrg("Synthetic customer office");
    const provider = await request(app).post("/api/auth/signup").send({
      organization_name: `Synthetic provider ${Date.now()}`, org_type: "service_partner",
      email: `provider-${Date.now()}@example.invalid`, password: "password12345", full_name: "Provider admin",
    });
    expect(provider.status).toBe(201);
    const facility = await createPortfolioHierarchy(customer.token);
    await createTestOpening(customer.token, facility.buildingId);
    const person = await pool.query("SELECT id FROM users WHERE lower(email)=lower($1)", [customer.email]);
    await pool.query(
      "INSERT INTO organization_memberships (user_id, organization_id, role, is_active, is_home) VALUES ($1,$2,'admin',true,false)",
      [person.rows[0].id, provider.body.organizationId],
    );
    const switched = await request(app).post("/api/auth/switch-company").set("Authorization", `Bearer ${customer.token}`).send({ organization_id: provider.body.organizationId });
    expect(switched.status).toBe(200);
    expect(switched.body.role).toBe("admin");
    const asProvider = switched.body.token as string;
    const url = "/api/portfolio/facility-dashboard/" + facility.propertyId;
    const denied = await request(app).get(url).set("Authorization", `Bearer ${asProvider}`);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: "facility_dashboard_forbidden" });
    expect((await request(app).get("/api/portfolio/facility-dashboard-access").set("Authorization", `Bearer ${asProvider}`)).status).toBe(403);
    const back = await request(app).post("/api/auth/switch-company").set("Authorization", `Bearer ${asProvider}`).send({ organization_id: customer.organizationId });
    expect(back.status).toBe(200);
    expect(back.body.role).toBe("admin");
    expect((await request(app).get("/api/portfolio/facility-dashboard-access").set("Authorization", `Bearer ${back.body.token}`)).body).toEqual({ allowed: true });
    expect((await request(app).get(url).set("Authorization", `Bearer ${back.body.token}`)).status).toBe(200);
    const other = await signupTestOrg("Synthetic other customer");
    const otherFacility = await createPortfolioHierarchy(other.token);
    expect((await request(app).get("/api/portfolio/facility-dashboard/" + otherFacility.propertyId).set("Authorization", `Bearer ${back.body.token}`)).status).toBe(404);
  });

  it("follows the active membership and ignores a stale users.role on every request and company switch", async () => {
    expect(AUTH_CONTEXT_SQL).toContain("user_authorized_orgs");
    expect(AUTH_CONTEXT_SQL).not.toMatch(/u\.role\b/);
    const customer = await signupTestOrg("Synthetic membership drift");
    const facility = await createPortfolioHierarchy(customer.token);
    const url = "/api/portfolio/facility-dashboard/" + facility.propertyId;
    const person = (await pool.query("SELECT id, role, is_active FROM users WHERE lower(email)=lower($1)", [customer.email])).rows[0];
    await pool.query("UPDATE organization_memberships SET role='technician' WHERE user_id=$1 AND organization_id=$2 AND is_home", [person.id, customer.organizationId]);
    const drifted = (await pool.query("SELECT u.role AS user_role, m.role AS membership_role, u.is_active, m.is_active AS membership_active FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id WHERE u.id=$1", [person.id])).rows[0];
    expect(drifted).toMatchObject({ user_role: "admin", membership_role: "technician", is_active: true, membership_active: true });
    const deniedMe = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${customer.token}`);
    expect(deniedMe.status).toBe(200);
    expect(deniedMe.body.role).toBe("technician");
    const denied = await request(app).get(url).set("Authorization", `Bearer ${customer.token}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("facility_dashboard_forbidden");
    expect(denied.body.openings).toBeUndefined();

    await pool.query("ALTER TABLE users DISABLE TRIGGER users_sync_home_membership");
    try {
      await pool.query("UPDATE users SET role='viewer' WHERE id=$1", [person.id]);
      await pool.query("UPDATE organization_memberships SET role='facilities_manager' WHERE user_id=$1 AND is_home", [person.id]);
    } finally {
      await pool.query("ALTER TABLE users ENABLE TRIGGER users_sync_home_membership");
    }
    const office = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${customer.token}`);
    expect(office.body.role).toBe("facilities_manager");
    expect((await request(app).get("/api/portfolio/facility-dashboard-access").set("Authorization", `Bearer ${customer.token}`)).body).toEqual({ allowed: true });
    expect((await pool.query("SELECT role FROM users WHERE id=$1", [person.id])).rows[0].role).toBe("viewer");

    const second = await signupTestOrg("Synthetic second company");
    await pool.query("INSERT INTO organization_memberships (user_id, organization_id, role, is_active, is_home) VALUES ($1,$2,'technician',true,false)", [person.id, second.organizationId]);
    const switched = await request(app).post("/api/auth/switch-company").set("Authorization", `Bearer ${customer.token}`).send({ organization_id: second.organizationId });
    expect(switched.status).toBe(200);
    expect(switched.body.role).toBe("technician");
    expect((await request(app).get(url).set("Authorization", `Bearer ${switched.body.token}`)).status).toBe(403);
    const homeAgain = await request(app).post("/api/auth/switch-company").set("Authorization", `Bearer ${switched.body.token}`).send({ organization_id: customer.organizationId });
    expect(homeAgain.body.role).toBe("facilities_manager");

    await pool.query("ALTER TABLE organization_memberships DISABLE TRIGGER memberships_home_deactivates_user");
    try {
      await pool.query("UPDATE organization_memberships SET is_active=false, deactivated_at=now() WHERE user_id=$1 AND organization_id=$2 AND is_home", [person.id, customer.organizationId]);
    } finally {
      await pool.query("ALTER TABLE organization_memberships ENABLE TRIGGER memberships_home_deactivates_user");
    }
    const kept = (await pool.query("SELECT role, is_active FROM users WHERE id=$1", [person.id])).rows[0];
    expect(kept).toMatchObject({ role: "viewer", is_active: true });
    const revoked = await request(app).get(url).set("Authorization", `Bearer ${homeAgain.body.token}`);
    expect(revoked.status).toBe(403);
    expect(revoked.body.error).toBe("membership_inactive");
    expect(revoked.body.openings).toBeUndefined();
    const switchBack = await request(app).post("/api/auth/switch-company").set("Authorization", `Bearer ${switched.body.token}`).send({ organization_id: customer.organizationId });
    expect(switchBack.status).toBe(403);
    expect(switchBack.body.error).toBe("membership_inactive");
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${switched.body.token}`)).body.role).toBe("technician");
  });
});
