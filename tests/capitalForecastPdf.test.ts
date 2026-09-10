import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("capital forecast PDF export", () => {
  it("generates a real PDF for a single property", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await request(app).post(`/api/openings/${opening.id}/recompute-health-score`).set("Authorization", `Bearer ${org.token}`);

    const res = await request(app)
      .get(`/api/export/capital-forecast.pdf?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("generates a real PDF for the portfolio rollup when property_id is omitted", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await request(app).post(`/api/openings/${opening.id}/recompute-health-score`).set("Authorization", `Bearer ${org.token}`);

    const res = await request(app)
      .get("/api/export/capital-forecast.pdf")
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("accepts custom cost assumptions via the costs query param without erroring", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_type: "gate" });
    await request(app).post(`/api/openings/${opening.id}/recompute-health-score`).set("Authorization", `Bearer ${org.token}`);

    const costs = encodeURIComponent(JSON.stringify({ gate: 9999 }));
    const res = await request(app)
      .get(`/api/export/capital-forecast.pdf?property_id=${propertyId}&costs=${costs}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("rejects malformed JSON in the costs param instead of crashing", async () => {
    const org = await signupTestOrg();
    const { propertyId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .get(`/api/export/capital-forecast.pdf?property_id=${propertyId}&costs=not-json{{{`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(400);
  });

  it("rejects a property belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { propertyId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .get(`/api/export/capital-forecast.pdf?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${orgB.token}`);
    expect(res.status).toBe(403);
  });

  it("the portfolio rollup PDF path succeeds even with no data (edge case, not an error)", async () => {
    const org = await signupTestOrg();

    const res = await request(app)
      .get("/api/export/capital-forecast.pdf")
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe("%PDF");
  });
});
