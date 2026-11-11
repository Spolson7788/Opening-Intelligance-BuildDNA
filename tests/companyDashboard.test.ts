import { describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { app, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { accountKind, attentionText, groupCustomers, mayOpenCompanyDashboard, COMPANY_DASHBOARD_REFUSAL } from "../src/services/companyDashboard";

describe("company dashboard account kinds", () => {
  it("keeps facility grants separate from provider-owned sites", () => {
    expect(mayOpenCompanyDashboard("admin")).toBe(true);
    expect(mayOpenCompanyDashboard("facilities_manager")).toBe(true);
    for (const role of ["technician", "inspector", "viewer", null]) expect(mayOpenCompanyDashboard(role)).toBe(false);
    expect(accountKind(false, "Northwind Clinics")).toBe("facility");
    expect(accountKind(true, "Maple Street Offices")).toBe("small");
    expect(accountKind(true, "Walk-in calls")).toBe("walkin");
    expect(accountKind(true, "walk in bucket")).toBe("walkin");
    expect(attentionText(0)).toBe("Nothing waiting");
    expect(attentionText(1)).toBe("1 needs attention");
    const rows = groupCustomers([
      { id: "p1", name: "Clinic A", address: "1 Main", isOwner: false, ownerId: "cust", ownerName: "Northwind", openingCount: 2, attentionCount: 1, lastVisit: "2026-10-01", nextDue: "2026-12-01" },
      { id: "p2", name: "Clinic B", address: "2 Main", isOwner: false, ownerId: "cust", ownerName: "Northwind", openingCount: 3, attentionCount: 0, lastVisit: "2026-11-01", nextDue: "2026-11-15" },
      { id: "p3", name: "Maple Street Offices", address: "220 Maple", isOwner: true, ownerId: "prov", ownerName: "Harbor", openingCount: 1, attentionCount: 0, lastVisit: null, nextDue: null },
      { id: "p4", name: "Walk-in calls", address: "410 Market", isOwner: true, ownerId: "prov", ownerName: "Harbor", openingCount: 1, attentionCount: 1, lastVisit: "2026-08-01", nextDue: null },
    ]);
    const facility = rows.find((row) => row.kind === "facility");
    expect(facility).toMatchObject({ name: "Northwind", opening_count: 5, attention_count: 1, last_visit: "2026-11-01", next_due: "2026-11-15" });
    expect(rows.find((row) => row.name === "Maple Street Offices")?.kind).toBe("small");
    expect(rows.find((row) => row.name === "Walk-in calls")?.kind).toBe("walkin");
  });
});

async function signup(orgType: "customer" | "service_partner", role = "admin") {
  const stamp = `${orgType}-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = await request(app).post("/api/auth/signup").send({
    organization_name: `Synthetic ${stamp}`, org_type: orgType, email: `${stamp}@example.invalid`, password: "password12345", full_name: "Synthetic",
  });
  expect(created.status).toBe(201);
  if (role === "admin") return { token: created.body.token as string, organizationId: created.body.organizationId as string };
  const email = `${role}-${stamp}@example.invalid`;
  await request(app).post("/api/auth/register").set("Authorization", `Bearer ${created.body.token}`).send({ email, password: "password12345", full_name: role, role });
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  expect(login.status).toBe(200);
  return { token: login.body.token as string, organizationId: created.body.organizationId as string };
}

describe("company dashboard access", () => {
  it("refuses technicians and inspectors and lists granted and owned sites for an admin", async () => {
    const provider = await signup("service_partner");
    const technician = await signup("service_partner", "technician");
    const inspector = await signup("service_partner", "inspector");
    const manager = await signup("service_partner", "facilities_manager");
    const customer = await signup("customer");
    const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${provider.token}`);
    expect(portfolios.status).toBe(200);
    const small = await request(app).post("/api/portfolio/properties").set("Authorization", `Bearer ${provider.token}`).send({ portfolio_id: portfolios.body[0].id, name: "Maple Street Offices", property_type: "other" });
    const walkin = await request(app).post("/api/portfolio/properties").set("Authorization", `Bearer ${provider.token}`).send({ portfolio_id: portfolios.body[0].id, name: "Walk-in calls", property_type: "other" });
    expect(small.status).toBe(201);
    expect(walkin.status).toBe(201);
    const facility = await createPortfolioHierarchy(customer.token);
    await createTestOpening(customer.token, facility.buildingId);
    const grant = await request(app).put(`/api/provider-assignments/${facility.propertyId}/${provider.organizationId}`).set("Authorization", `Bearer ${customer.token}`).send({ active: true });
    expect(grant.status).toBe(200);

    const home = await request(app).get("/api/company-dashboard").set("Authorization", `Bearer ${provider.token}`);
    expect(home.status).toBe(200);
    expect(home.body.counts.quotes).toBe(0);
    const kinds = home.body.customers.map((row: { kind: string; name: string }) => `${row.kind}:${row.name}`);
    expect(kinds).toContain("small:Maple Street Offices");
    expect(kinds).toContain("walkin:Walk-in calls");
    expect(home.body.customers.some((row: { kind: string; opening_count: number }) => row.kind === "facility" && row.opening_count >= 1)).toBe(true);
    expect(home.body.classification_note).toContain("Walk-in");

    const site = await request(app).get(`/api/company-dashboard/sites/${small.body.id}`).set("Authorization", `Bearer ${provider.token}`);
    expect(site.status).toBe(200);
    expect(site.body.kind).toBe("small");
    expect(site.body.openings).toEqual([]);
    expect(site.body.visits).toEqual([]);

    for (const token of [technician.token, inspector.token]) {
      const denied = await request(app).get("/api/company-dashboard").set("Authorization", `Bearer ${token}`);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: "company_dashboard_forbidden", message: COMPANY_DASHBOARD_REFUSAL });
      expect(denied.body.customers).toBeUndefined();
      const siteDenied = await request(app).get(`/api/company-dashboard/sites/${facility.propertyId}`).set("Authorization", `Bearer ${token}`);
      expect(siteDenied.status).toBe(403);
      expect(siteDenied.body.openings).toBeUndefined();
    }
    expect((await request(app).get("/api/company-dashboard").set("Authorization", `Bearer ${manager.token}`)).status).toBe(200);
    expect((await request(app).get("/api/company-dashboard")).status).toBe(401);
    const fieldList = await request(app).get("/api/portfolio/properties").set("Authorization", `Bearer ${technician.token}`);
    expect(fieldList.status).toBe(200);

    const appSource = readFileSync("dashboard/src/App.tsx", "utf8");
    expect(appSource).toContain(COMPANY_DASHBOARD_REFUSAL.replace("Company administrators and managers use this dashboard. Technicians and inspectors use the field app.", "Technicians and inspectors use the field app."));
    expect(appSource).toContain('href="/field/scan"');
  });
});
