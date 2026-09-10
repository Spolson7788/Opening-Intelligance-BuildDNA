import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

async function waitForAuditLog() {
  await new Promise((r) => setTimeout(r, 200));
}

describe("audit log", () => {
  it("logs a successful mutation with the correct human-readable action", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId);
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((e: any) => e.action === "Created opening")).toBe(true);
  });

  it("records who did it, by joining against the real user", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId);
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${org.token}`);
    const entry = res.body.find((e: any) => e.action === "Created opening");
    expect(entry.user_email).toBeTruthy();
    expect(entry.user_full_name).toBeTruthy();
  });

  it("redacts a password field if one appears in the logged request body", async () => {
    const org = await signupTestOrg();
    const email = `audit-redact-${Date.now()}@example.com`;
    await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ email, password: "super-secret-password", full_name: "X", role: "viewer" });
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${org.token}`);
    const entry = res.body.find((e: any) => e.action === "Invited team member");
    expect(entry).toBeTruthy();
    expect(entry.request_body.password).toBe("[redacted]");
    expect(JSON.stringify(entry.request_body)).not.toContain("super-secret-password");
  });

  it("does NOT log a read (GET) request", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId);
    await request(app).get("/api/openings").set("Authorization", `Bearer ${org.token}`);
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${org.token}`);
    expect(res.body.some((e: any) => e.method === "GET" && e.path === "/api/openings")).toBe(false);
  });

  it("does NOT log a mutation that failed (non-2xx)", async () => {
    const org = await signupTestOrg();
    await request(app).post("/api/openings").set("Authorization", `Bearer ${org.token}`).send({});
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${org.token}`);
    const openingsList = await request(app).get("/api/openings").set("Authorization", `Bearer ${org.token}`);
    expect(openingsList.body.length).toBe(0);
    expect(res.body.filter((e: any) => e.action === "Created opening").length).toBe(0);
  });

  it("does NOT log a blocked (403) mutation from an insufficient role", async () => {
    const org = await signupTestOrg();
    const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${org.token}`);
    const email = `audit-viewer-${Date.now()}@example.com`;
    const password = "password12345";
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`)
      .send({ email, password, full_name: "Viewer", role: "viewer" });
    const login = await request(app).post("/api/auth/login").send({ email, password });

    await request(app)
      .post("/api/portfolio/properties")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ portfolio_id: portfolios.body[0].id, name: "Should be blocked and not logged" });
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${org.token}`);
    expect(res.body.some((e: any) => e.action === "Created property")).toBe(false);
  });

  it("does NOT log recompute-health-score (excluded as a derived, non-human change)", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await request(app).post(`/api/openings/${opening.id}/recompute-health-score`).set("Authorization", `Bearer ${org.token}`);
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${org.token}`);
    expect(res.body.some((e: any) => e.path.includes("recompute-health-score"))).toBe(false);
  });

  it("never shows another org's audit entries", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    await createTestOpening(orgA.token, buildingId, { opening_code: "ORG-A-AUDIT-ONLY" });
    await waitForAuditLog();

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${orgB.token}`);
    expect(res.body.every((e: any) => !JSON.stringify(e.request_body).includes("ORG-A-AUDIT-ONLY"))).toBe(true);
  });

  it("a technician cannot view the audit log", async () => {
    const org = await signupTestOrg();
    const email = `audit-tech-${Date.now()}@example.com`;
    const password = "password12345";
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`)
      .send({ email, password, full_name: "Tech", role: "technician" });
    const login = await request(app).post("/api/auth/login").send({ email, password });

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });

  it("a facilities_manager CAN view the audit log (unlike technician/viewer)", async () => {
    const org = await signupTestOrg();
    const email = `audit-fm-${Date.now()}@example.com`;
    const password = "password12345";
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`)
      .send({ email, password, full_name: "FM", role: "facilities_manager" });
    const login = await request(app).post("/api/auth/login").send({ email, password });

    const res = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/audit-log");
    expect(res.status).toBe(401);
  });
});
