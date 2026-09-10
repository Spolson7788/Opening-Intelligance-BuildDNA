import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("batch QR codes", () => {
  it("returns a QR code for every opening in the building", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { opening_code: "QR-001" });
    await createTestOpening(org.token, buildingId, { opening_code: "QR-002" });
    await createTestOpening(org.token, buildingId, { opening_code: "QR-003" });

    const res = await request(app)
      .get(`/api/openings/qr-codes?building_id=${buildingId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.items.length).toBe(3);
    expect(res.body.items.every((i: any) => i.qr_data_url.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it("the /qr-codes route is genuinely reachable and not shadowed by /:id", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .get(`/api/openings/qr-codes?building_id=${buildingId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).not.toBe(404);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("count");
  });

  it("requires building_id", async () => {
    const org = await signupTestOrg();
    const res = await request(app).get("/api/openings/qr-codes").set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(400);
  });

  it("rejects a building belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .get(`/api/openings/qr-codes?building_id=${buildingId}`)
      .set("Authorization", `Bearer ${orgB.token}`);
    expect(res.status).toBe(403);
  });

  it("returns an empty (not error) result for a building with no openings yet", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .get(`/api/openings/qr-codes?building_id=${buildingId}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});
