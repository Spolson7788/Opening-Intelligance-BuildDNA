import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("events", () => {
  it("logs a service event and updates the opening's last_service_date", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/events/service-events")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, event_date: "2026-01-15", work_performed: "Adjusted closer" });
    expect(res.status).toBe(201);

    const updated = await request(app)
      .get(`/api/openings/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(updated.body.last_service_date).toContain("2026-01-15");
    expect(updated.body.service_events.length).toBe(1);
  });

  it("logs an inspection event with a failure and notes", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });

    const res = await request(app)
      .post("/api/events/inspection-events")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        event_date: "2026-02-01",
        inspection_type: "fire_door_nfpa80",
        passed: false,
        notes: "Gap exceeds tolerance",
      });
    expect(res.status).toBe(201);
    expect(res.body.passed).toBe(false);
  });

  it("rejects logging an event against another org's opening", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .post("/api/events/service-events")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ opening_id: opening.id, event_date: "2026-01-01", work_performed: "Should not work" });
    expect(res.status).toBe(403);
  });

  it("recomputing health score after a failed inspection lowers the score", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });

    const before = await request(app)
      .post(`/api/openings/${opening.id}/recompute-health-score`)
      .set("Authorization", `Bearer ${org.token}`);
    const scoreBefore = before.body.score;

    await request(app)
      .post("/api/events/inspection-events")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        event_date: new Date().toISOString().slice(0, 10),
        inspection_type: "fire_door_nfpa80",
        passed: false,
        notes: "Failed",
      });

    const after = await request(app)
      .post(`/api/openings/${opening.id}/recompute-health-score`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(after.body.score).toBeLessThan(scoreBefore);
    expect(after.body.factors).toBeTruthy(); // score should always come with an explainable breakdown
  });
});
