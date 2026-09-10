import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

// The forecast endpoint only reads openings.health_score, which is only ever
// set via a real recompute against real inputs (age, service history,
// inspections) — there's no "just set it to X" shortcut, and there
// shouldn't be, since that's exactly the kind of shortcut that would let a
// test pass without actually exercising the real scoring path.
async function recompute(token: string, openingId: string) {
  const res = await request(app)
    .post(`/api/openings/${openingId}/recompute-health-score`)
    .set("Authorization", `Bearer ${token}`);
  return res.body.score as number;
}

describe("capital forecast", () => {
  it("buckets an opening with no health score yet as unassessed", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId); // never scored, never recomputed

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.buckets.unassessed.total).toBe(1);
    expect(res.body.total_openings).toBe(1);
  });

  it("a brand-new, never-serviced opening lands in a real, correctly-bucketed score", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, {
      install_date: new Date().toISOString().slice(0, 10),
    });
    const score = await recompute(org.token, opening.id);

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    // Whichever bucket the real score actually falls into should have
    // exactly this one opening — cross-checking the forecast endpoint
    // against the real score rather than assuming which bucket it lands in.
    const expectedBucket = score < 50 ? "urgent" : score < 75 ? "near_term" : "healthy";
    expect(res.body.buckets[expectedBucket].total).toBe(1);
  });

  it("breaks down each bucket by opening_type, not one undifferentiated count", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const door = await createTestOpening(org.token, buildingId, { opening_type: "door" });
    const gate = await createTestOpening(org.token, buildingId, { opening_type: "gate" });
    await recompute(org.token, door.id);
    await recompute(org.token, gate.id);

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    const populatedBucket = Object.values(res.body.buckets).find((b: any) => b.total > 0) as any;
    expect(populatedBucket).toBeTruthy();
    expect(populatedBucket.by_type.door).toBe(1);
    expect(populatedBucket.by_type.gate).toBe(1);
  });

  it("rejects a property belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { propertyId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${orgB.token}`);
    expect(res.status).toBe(403);
  });

  it("requires property_id", async () => {
    const org = await signupTestOrg();
    const res = await request(app).get("/api/portfolio/capital-forecast").set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(400);
  });

  it("returns all four buckets even when some are empty", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.buckets).toHaveProperty("urgent");
    expect(res.body.buckets).toHaveProperty("near_term");
    expect(res.body.buckets).toHaveProperty("healthy");
    expect(res.body.buckets).toHaveProperty("unassessed");
  });

  // This is the actual point of the cost/supplier work: an opening with a
  // real priced part should contribute a real dollar figure to the bucket,
  // and should NOT also be counted toward the generic per-type estimate —
  // otherwise a priced opening would get double-counted (once for real,
  // once as a guess) in the total.
  it("an opening with a priced hardware component contributes to known_cost_total, not needing_estimate_by_type", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_type: "door" });

    await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset", unit_cost: 340.5 });

    const recompute = await request(app)
      .post(`/api/openings/${opening.id}/recompute-health-score`)
      .set("Authorization", `Bearer ${org.token}`);
    const bucketKey = recompute.body.score < 50 ? "urgent" : recompute.body.score < 75 ? "near_term" : "healthy";

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.buckets[bucketKey].known_cost_total).toBe(340.5);
    expect(res.body.buckets[bucketKey].needing_estimate_by_type.door).toBeUndefined();
  });

  it("an opening with no priced hardware still shows up in needing_estimate_by_type", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_type: "gate" });
    await request(app)
      .post(`/api/openings/${opening.id}/recompute-health-score`)
      .set("Authorization", `Bearer ${org.token}`);

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    const anyBucket = Object.values(res.body.buckets).find((b: any) => b.needing_estimate_by_type.gate === 1);
    expect(anyBucket).toBeTruthy();
  });

  it("sums multiple priced parts on the same opening into one known_cost_total", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_type: "door" });

    await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset", unit_cost: 200 });
    await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "closer", unit_cost: 150 });

    const recompute = await request(app)
      .post(`/api/openings/${opening.id}/recompute-health-score`)
      .set("Authorization", `Bearer ${org.token}`);
    const bucketKey = recompute.body.score < 50 ? "urgent" : recompute.body.score < 75 ? "near_term" : "healthy";

    const res = await request(app)
      .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.buckets[bucketKey].known_cost_total).toBe(350);
  });
});
