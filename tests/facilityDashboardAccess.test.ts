import { describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { customerMayOpenFacilityDashboard } from "../src/services/facilityDashboardAccess";

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
    expect(readFileSync("field-app/src/pages/ScanPage.tsx", "utf8")).not.toContain("facility-dashboard");
  });
});
