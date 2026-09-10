import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("tenant isolation", () => {
  it("org B cannot list org A's openings", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    await createTestOpening(orgA.token, buildingId);

    const resA = await request(app).get("/api/openings").set("Authorization", `Bearer ${orgA.token}`);
    const resB = await request(app).get("/api/openings").set("Authorization", `Bearer ${orgB.token}`);

    expect(resA.body.length).toBeGreaterThan(0);
    expect(resB.body.length).toBe(0);
  });

  it("org B cannot fetch org A's opening by id", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .get(`/api/openings/${opening.id}`)
      .set("Authorization", `Bearer ${orgB.token}`);
    expect(res.status).toBe(404); // not 403 — existence itself shouldn't leak
  });

  it("org B cannot create an opening under org A's building", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .post("/api/openings")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ opening_code: "SHOULD-FAIL-001", building_id: buildingId, opening_type: "door" });
    expect(res.status).toBe(403);
  });

  it("org B cannot see org A's properties in the portfolio picker", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    await createPortfolioHierarchy(orgA.token);

    const res = await request(app).get("/api/portfolio/properties").set("Authorization", `Bearer ${orgB.token}`);
    expect(res.body.length).toBe(0);
  });

  it("org B cannot add hardware to org A's opening", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ opening_id: opening.id, component_type: "lockset" });
    expect(res.status).toBe(403);
  });

  it("org B's CSV export never contains org A's data", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app).get("/api/export/openings.csv").set("Authorization", `Bearer ${orgB.token}`);
    expect(res.text).not.toContain(opening.opening_code);
  });

  it("requests with no token are rejected across the board", async () => {
    const endpoints = ["/api/openings", "/api/hardware", "/api/portfolio/properties", "/api/export/openings.csv"];
    for (const endpoint of endpoints) {
      const res = await request(app).get(endpoint);
      expect(res.status).toBe(401);
    }
  });
});
