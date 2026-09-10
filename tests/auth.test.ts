import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg } from "./helpers";

describe("auth", () => {
  it("signup creates an org and issues a working token", async () => {
    const org = await signupTestOrg();
    expect(org.token).toBeTruthy();
    expect(org.organizationId).toBeTruthy();
  });

  it("signup rejects a duplicate email", async () => {
    const org = await signupTestOrg();
    const res = await request(app).post("/api/auth/signup").send({
      organization_name: "Another Org",
      email: org.email,
      password: "somepassword123",
      full_name: "Someone Else",
    });
    expect(res.status).toBe(409);
  });

  it("login works with the signed-up credentials", async () => {
    const email = `login-${Date.now()}@example.com`;
    await request(app).post("/api/auth/signup").send({
      organization_name: "Login Test Org",
      email,
      password: "correctpassword123",
      full_name: "Login Tester",
    });

    const res = await request(app).post("/api/auth/login").send({ email, password: "correctpassword123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("login rejects a wrong password", async () => {
    const org = await signupTestOrg();
    const res = await request(app).post("/api/auth/login").send({ email: org.email, password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  // Regression test: /api/auth/register used to accept any organization_id
  // in the request body with no proof of authorization, so anyone who
  // guessed another customer's org UUID could add themselves as an admin to
  // it. Fixed by requiring auth and deriving the org from the caller's own
  // token. This test exists specifically so that bug can't come back silently.
  it("register requires authentication", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "unauthorized@example.com",
      password: "password12345",
      full_name: "Should Not Work",
      role: "admin",
    });
    expect(res.status).toBe(401);
  });

  it("register requires the caller to be an admin", async () => {
    // Sign up org A (admin), then have that admin invite a non-admin user,
    // then confirm the non-admin user cannot themselves invite anyone.
    const orgA = await signupTestOrg();
    const inviteRes = await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${orgA.token}`)
      .send({ email: `viewer-${Date.now()}@example.com`, password: "password12345", full_name: "Viewer User", role: "viewer" });
    expect(inviteRes.status).toBe(201);

    const viewerLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: inviteRes.body.email, password: "password12345" });
    const viewerToken = viewerLogin.body.token;

    const secondInviteAttempt = await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ email: `nope-${Date.now()}@example.com`, password: "password12345", full_name: "Nope", role: "admin" });
    expect(secondInviteAttempt.status).toBe(403);
  });

  it("register adds the new user to the caller's own organization, not an arbitrary one", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");

    // Even if org A's admin tries to slip org B's id into the body, the
    // server must ignore it and use org A's id (from the verified token).
    const res = await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${orgA.token}`)
      .send({
        email: `sneaky-${Date.now()}@example.com`,
        password: "password12345",
        full_name: "Sneaky",
        role: "admin",
        organization_id: orgB.organizationId, // should be ignored entirely
      });
    expect(res.status).toBe(201);
    expect(res.body.organization_id).toBe(orgA.organizationId);
    expect(res.body.organization_id).not.toBe(orgB.organizationId);
  });

  it("signup creates a default portfolio, so a new org can create a property immediately", async () => {
    const org = await signupTestOrg();
    const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${org.token}`);
    expect(portfolios.body.length).toBeGreaterThanOrEqual(1);

    const property = await request(app)
      .post("/api/portfolio/properties")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ portfolio_id: portfolios.body[0].id, name: "Immediate Property" });
    expect(property.status).toBe(201);
  });
});
