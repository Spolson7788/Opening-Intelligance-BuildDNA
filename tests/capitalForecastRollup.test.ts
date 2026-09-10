import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("capital forecast rollup", () => {
  it("the rollup route is genuinely reachable, not shadowed by /capital-forecast", async () => {
    const org = await signupTestOrg();
    const res = await request(app).get("/api/portfolio/capital-forecast/rollup").set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("properties");
  });

  it("includes every property the org owns, even ones with zero openings", async () => {
    const org = await signupTestOrg();
    await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .get("/api/portfolio/capital-forecast/rollup")
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.properties.length).toBeGreaterThanOrEqual(1);
    expect(res.body.properties[0].total_openings).toBe(0);
  });

  it("correctly separates buckets and costs across two distinct properties", async () => {
    const org = await signupTestOrg();
    const { buildingId: buildingA, propertyId: propertyA } = await createPortfolioHierarchy(org.token);

    const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${org.token}`);
    const propertyBRes = await request(app)
      .post("/api/portfolio/properties")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ portfolio_id: portfolios.body[0].id, name: "Second Property" });
    const buildingBRes = await request(app)
      .post("/api/portfolio/buildings")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ property_id: propertyBRes.body.id, name: "Building B" });

    const openingA = await createTestOpening(org.token, buildingA, { opening_code: "ROLLUP-A-001" });
    await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: openingA.id, component_type: "lockset", unit_cost: 500 });
    await request(app).post(`/api/openings/${openingA.id}/recompute-health-score`).set("Authorization", `Bearer ${org.token}`);

    const openingB = await createTestOpening(org.token, buildingBRes.body.id, { opening_code: "ROLLUP-B-001" });
    await request(app).post(`/api/openings/${openingB.id}/recompute-health-score`).set("Authorization", `Bearer ${org.token}`);

    const res = await request(app)
      .get("/api/portfolio/capital-forecast/rollup")
      .set("Authorization", `Bearer ${org.token}`);

    const propA = res.body.properties.find((p: any) => p.property_id === propertyA);
    const propB = res.body.properties.find((p: any) => p.property_id === propertyBRes.body.id);

    expect(propA.total_openings).toBe(1);
    expect(propB.total_openings).toBe(1);
    const propAKnownCost = Object.values(propA.buckets).reduce((sum: number, b: any) => sum + b.known_cost_total, 0);
    const propBKnownCost = Object.values(propB.buckets).reduce((sum: number, b: any) => sum + b.known_cost_total, 0);
    expect(propAKnownCost).toBe(500);
    expect(propBKnownCost).toBe(0);
  });

  it("never includes another org's properties", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { propertyId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .get("/api/portfolio/capital-forecast/rollup")
      .set("Authorization", `Bearer ${orgB.token}`);

    expect(res.body.properties.find((p: any) => p.property_id === propertyId)).toBeUndefined();
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/portfolio/capital-forecast/rollup");
    expect(res.status).toBe(401);
  });
});
