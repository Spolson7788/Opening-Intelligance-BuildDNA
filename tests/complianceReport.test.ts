import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("compliance report", () => {
  it("generates a PDF for fire-rated openings by default", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { fire_rated: true });

    const res = await request(app)
      .get(`/api/export/compliance-report.pdf?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("excludes non-fire-rated, non-life-safety openings by default", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { fire_rated: false, life_safety_critical: false });

    const res = await request(app)
      .get(`/api/export/compliance-report.pdf?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(404);
  });

  it("?scope=all includes non-fire-rated openings too", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { fire_rated: false, life_safety_critical: false });

    const res = await request(app)
      .get(`/api/export/compliance-report.pdf?property_id=${propertyId}&scope=all`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("rejects a property belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId, propertyId } = await createPortfolioHierarchy(orgA.token);
    await createTestOpening(orgA.token, buildingId, { fire_rated: true });

    const res = await request(app)
      .get(`/api/export/compliance-report.pdf?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${orgB.token}`);
    expect(res.status).toBe(403);
  });

  it("requires property_id", async () => {
    const org = await signupTestOrg();
    const res = await request(app).get("/api/export/compliance-report.pdf").set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(400);
  });

  it("includes a failed inspection in the report data path without erroring", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });

    await request(app)
      .post("/api/events/inspection-events")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        event_date: "2026-01-01",
        inspection_type: "fire_door_nfpa80",
        passed: false,
        notes: "Gap exceeds tolerance",
      });

    const res = await request(app)
      .get(`/api/export/compliance-report.pdf?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe("%PDF");
  });
});
