import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("bulk import", () => {
  it("creates multiple openings in one request", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .post("/api/openings/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        building_id: buildingId,
        rows: [
          { opening_code: "BULK-001", opening_type: "door", floor_label: "F01" },
          { opening_code: "BULK-002", opening_type: "door", floor_label: "F01" },
          { opening_code: "BULK-003", opening_type: "gate" },
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.total).toBe(3);
    expect(res.body.created).toBe(3);
    expect(res.body.failed).toBe(0);
    expect(res.body.results.every((r: any) => r.status === "created")).toBe(true);
  });

  it("reports partial success when some rows fail and still creates the good ones", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const existing = await createTestOpening(org.token, buildingId, { opening_code: "DUPLICATE-001" });

    const res = await request(app)
      .post("/api/openings/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        building_id: buildingId,
        rows: [
          { opening_code: "GOOD-001", opening_type: "door" },
          { opening_code: existing.opening_code, opening_type: "door" },
          { opening_code: "GOOD-002", opening_type: "door" },
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.total).toBe(3);
    expect(res.body.created).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[1].status).toBe("error");
    expect(res.body.results[1].error).toBe("opening_code already exists");
    expect(res.body.results[0].status).toBe("created");
    expect(res.body.results[2].status).toBe("created");
  });

  it("rejects importing into a building that belongs to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .post("/api/openings/bulk-import")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ building_id: buildingId, rows: [{ opening_code: "SHOULD-FAIL", opening_type: "door" }] });

    expect(res.status).toBe(403);
  });

  it("rejects an empty rows array", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .post("/api/openings/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ building_id: buildingId, rows: [] });

    expect(res.status).toBe(400);
  });

  it("rejects a row with an invalid opening_type before touching the database", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .post("/api/openings/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ building_id: buildingId, rows: [{ opening_code: "BAD-TYPE", opening_type: "not_a_real_type" }] });

    expect(res.status).toBe(400);
  });

  it("imported openings are immediately visible in the normal openings list", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);

    await request(app)
      .post("/api/openings/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ building_id: buildingId, rows: [{ opening_code: "VISIBLE-001", opening_type: "door" }] });

    const list = await request(app).get("/api/openings").set("Authorization", `Bearer ${org.token}`);
    expect(list.body.some((o: any) => o.opening_code === "VISIBLE-001")).toBe(true);
  });
});
