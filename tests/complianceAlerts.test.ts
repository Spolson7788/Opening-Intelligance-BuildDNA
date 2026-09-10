import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function logInspection(token: string, openingId: string, eventDate: string) {
  await request(app)
    .post("/api/events/inspection-events")
    .set("Authorization", `Bearer ${token}`)
    .send({ opening_id: openingId, event_date: eventDate, inspection_type: "fire_door_nfpa80", passed: true });
}

describe("compliance alerts", () => {
  it("flags a fire-rated opening that has never been inspected", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { fire_rated: true });

    const res = await request(app)
      .get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.counts.never_inspected).toBe(1);
    expect(res.body.alerts[0].alert_level).toBe("never_inspected");
  });

  it("does NOT flag a non-fire-rated, non-life-safety opening, even if never inspected", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { fire_rated: false, life_safety_critical: false });

    const res = await request(app)
      .get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.total_flagged).toBe(0);
  });

  it("flags an opening inspected 400 days ago as overdue (past the 365-day NFPA 80 mark)", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });
    await logInspection(org.token, opening.id, daysAgo(400));

    const res = await request(app)
      .get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.counts.overdue).toBe(1);
  });

  it("flags an opening inspected 350 days ago as due_soon (within 30 days of the mark)", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { life_safety_critical: true });
    await logInspection(org.token, opening.id, daysAgo(350));

    const res = await request(app)
      .get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.counts.due_soon).toBe(1);
  });

  it("does NOT flag an opening inspected 30 days ago (well within compliance)", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });
    await logInspection(org.token, opening.id, daysAgo(30));

    const res = await request(app)
      .get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.total_flagged).toBe(0);
  });

  it("sorts overdue/never-inspected ahead of due-soon", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const dueSoon = await createTestOpening(org.token, buildingId, { fire_rated: true, opening_code: "DUE-SOON-001" });
    await logInspection(org.token, dueSoon.id, daysAgo(350));
    await createTestOpening(org.token, buildingId, { fire_rated: true, opening_code: "NEVER-INSPECTED-001" });

    const res = await request(app)
      .get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.alerts[0].alert_level).toBe("never_inspected");
    expect(res.body.alerts[1].alert_level).toBe("due_soon");
  });

  it("omitting property_id returns alerts across the whole org", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { fire_rated: true });

    const res = await request(app)
      .get("/api/portfolio/compliance-alerts")
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.total_flagged).toBeGreaterThanOrEqual(1);
  });

  it("rejects a property belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { propertyId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${orgB.token}`);
    expect(res.status).toBe(403);
  });

  it("org-wide alerts never include another org's openings", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    await createTestOpening(orgA.token, buildingId, { fire_rated: true, opening_code: "ORG-A-ONLY" });

    const res = await request(app)
      .get("/api/portfolio/compliance-alerts")
      .set("Authorization", `Bearer ${orgB.token}`);

    expect(res.body.alerts.find((a: any) => a.opening_code === "ORG-A-ONLY")).toBeUndefined();
  });
});
