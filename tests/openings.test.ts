import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("openings", () => {
  it("creates an opening and generates a unique qr_token", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    expect(opening.qr_token).toBeTruthy();
    expect(opening.status).toBe("pending_capture");
  });

  it("rejects a duplicate opening_code", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/openings")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_code: opening.opening_code, building_id: buildingId, opening_type: "door" });
    expect(res.status).toBe(409);
  });

  // Regression test: the field app's manual entry field let a technician type
  // the human-readable opening_code printed on the door tag, but the code
  // silently resolved it against qr_token (an internal UUID never shown to
  // anyone) via /by-qr — so a manually-typed real code always failed with
  // "not found". Fixed with a separate /by-code lookup.
  it("resolves an opening by its human-readable opening_code via /by-code", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .get(`/api/openings/by-code/${encodeURIComponent(opening.opening_code)}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(opening.id);
  });

  it("resolves an opening by its qr_token via /by-qr", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .get(`/api/openings/by-qr/${opening.qr_token}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(opening.id);
  });

  it("/by-code does NOT resolve when given a qr_token (proves the two lookups are genuinely distinct)", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .get(`/api/openings/by-code/${opening.qr_token}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(404);
  });

  it("filters the list by opening_type", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { opening_code: "GATE-001", opening_type: "gate" });
    await createTestOpening(org.token, buildingId, { opening_code: "DOOR-001", opening_type: "door" });

    const res = await request(app)
      .get("/api/openings?opening_type=gate")
      .set("Authorization", `Bearer ${org.token}`);
    expect(res.body.every((o: any) => o.opening_type === "gate")).toBe(true);
    expect(res.body.length).toBe(1);
  });

  it("filters the list by property_id", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .get(`/api/openings?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("persists is_electrified, defaulting to false when not specified", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);

    const electrified = await createTestOpening(org.token, buildingId, { opening_code: "ELEC-001", is_electrified: true });
    expect(electrified.is_electrified).toBe(true);

    const notElectrified = await createTestOpening(org.token, buildingId, { opening_code: "ELEC-002" });
    expect(notElectrified.is_electrified).toBe(false);
  });
});
