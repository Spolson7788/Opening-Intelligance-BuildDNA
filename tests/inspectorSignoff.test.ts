import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

const SAMPLE_SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("inspector sign-off", () => {
  it("stores a signature and auto-stamps signed_at", async () => {
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
        passed: true,
        signature_data: SAMPLE_SIGNATURE,
        signed_by_name: "Jamie Rivera",
      });

    expect(res.status).toBe(201);
    expect(res.body.signature_data).toBe(SAMPLE_SIGNATURE);
    expect(res.body.signed_by_name).toBe("Jamie Rivera");
    expect(res.body.signed_at).toBeTruthy();
  });

  it("an inspection with no signature has a null signed_at, not a fabricated one", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });

    const res = await request(app)
      .post("/api/events/inspection-events")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, event_date: "2026-02-01", inspection_type: "general", passed: true });

    expect(res.status).toBe(201);
    expect(res.body.signature_data).toBeNull();
    expect(res.body.signed_at).toBeNull();
  });

  it("rejects an absurdly oversized signature payload rather than accepting anything", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });

    const res = await request(app)
      .post("/api/events/inspection-events")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        event_date: "2026-02-01",
        inspection_type: "general",
        passed: true,
        signature_data: "data:image/png;base64," + "A".repeat(600_000),
      });

    expect(res.status).toBe(400);
  });

  it("a signed inspection shows up correctly in the opening's full detail view", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });

    await request(app)
      .post("/api/events/inspection-events")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        event_date: "2026-02-01",
        inspection_type: "fire_door_nfpa80",
        passed: true,
        signature_data: SAMPLE_SIGNATURE,
        signed_by_name: "Jamie Rivera",
      });

    const detail = await request(app).get(`/api/openings/${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(detail.body.inspection_events[0].signed_by_name).toBe("Jamie Rivera");
  });
});
