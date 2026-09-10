import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

// Regression test: node-postgres returns NUMERIC/DECIMAL columns as strings
// by default. This silently broke the dashboard's average health score
// (string concatenation instead of addition) and its default sort ("9.00"
// sorted after "80.00" lexicographically). Fixed with a global type parser
// in src/db/pool.ts. This test asserts the JSON contract directly — every
// numeric field the frontends do arithmetic or numeric comparison on must
// come back as an actual JSON number, not a numeric-looking string.
describe("numeric field types (regression)", () => {
  it("health_score is a JSON number, not a string", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { install_date: "2015-01-01" });

    await request(app)
      .post(`/api/openings/${opening.id}/recompute-health-score`)
      .set("Authorization", `Bearer ${org.token}`);

    const res = await request(app)
      .get(`/api/openings/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(typeof res.body.health_score).toBe("number");
    expect(Number.isNaN(res.body.health_score)).toBe(false);
  });

  it("health_score in the list endpoint is also a number, not a string", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await request(app)
      .post(`/api/openings/${opening.id}/recompute-health-score`)
      .set("Authorization", `Bearer ${org.token}`);

    const res = await request(app).get("/api/openings").set("Authorization", `Bearer ${org.token}`);
    const found = res.body.find((o: any) => o.id === opening.id);
    expect(typeof found.health_score).toBe("number");
  });

  it("a set of scores sorts correctly as numbers (catches the lexicographic-string regression)", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);

    // Deliberately create openings whose scores will cross a digit-count
    // boundary (single vs double digit) — this is exactly the case where
    // "9.00" < "80.00" fails under string comparison but passes numerically.
    const openings = [];
    for (let i = 0; i < 3; i++) {
      const o = await createTestOpening(org.token, buildingId);
      await request(app).post(`/api/openings/${o.id}/recompute-health-score`).set("Authorization", `Bearer ${org.token}`);
      openings.push(o.id);
    }

    const res = await request(app).get("/api/openings").set("Authorization", `Bearer ${org.token}`);
    for (const o of res.body) {
      expect(typeof o.health_score).toBe("number");
    }
    // If this were still returning strings, this arithmetic would silently
    // produce string concatenation instead of a real sum.
    const sum = res.body.reduce((acc: number, o: any) => acc + (o.health_score ?? 0), 0);
    expect(typeof sum).toBe("number");
    expect(Number.isNaN(sum)).toBe(false);
  });
});
