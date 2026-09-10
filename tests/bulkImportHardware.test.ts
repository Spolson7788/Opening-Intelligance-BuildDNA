import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("bulk hardware import", () => {
  it("attaches hardware to an existing opening by opening_code", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_code: "HW-BULK-001" });

    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        rows: [
          { opening_code: "HW-BULK-001", component_type: "lockset", manufacturer: "Schlage", unit_cost: 340.5 },
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.created).toBe(1);
    expect(res.body.results[0].status).toBe("created");

    const list = await request(app)
      .get(`/api/hardware/by-opening/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(list.body.length).toBe(1);
    expect(list.body[0].manufacturer).toBe("Schlage");
  });

  it("attaches many hardware parts to the same opening in one request", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_code: "HW-BULK-002" });

    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        rows: [
          { opening_code: "HW-BULK-002", component_type: "lockset" },
          { opening_code: "HW-BULK-002", component_type: "closer" },
          { opening_code: "HW-BULK-002", component_type: "hinge" },
          { opening_code: "HW-BULK-002", component_type: "hinge" },
          { opening_code: "HW-BULK-002", component_type: "hinge" },
          { opening_code: "HW-BULK-002", component_type: "keypad" },
          { opening_code: "HW-BULK-002", component_type: "electric_strike" },
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.created).toBe(7);

    const list = await request(app)
      .get(`/api/hardware/by-opening/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(list.body.length).toBe(7);
  });

  it("one CSV can attach hardware to openings across different buildings, since it doesn't require a building_id", async () => {
    const org = await signupTestOrg();
    const { buildingId: buildingA } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingA, { opening_code: "MULTI-BLDG-A" });

    const properties = await request(app).get("/api/portfolio/properties").set("Authorization", `Bearer ${org.token}`);
    const propertyId = properties.body[0].id;
    const buildingBRes = await request(app)
      .post("/api/portfolio/buildings")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ property_id: propertyId, name: "Building B" });
    await createTestOpening(org.token, buildingBRes.body.id, { opening_code: "MULTI-BLDG-B" });

    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        rows: [
          { opening_code: "MULTI-BLDG-A", component_type: "lockset" },
          { opening_code: "MULTI-BLDG-B", component_type: "closer" },
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.created).toBe(2);
  });

  it("reports a clear per-row error when an opening_code doesn't exist, without failing the rest of the batch", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { opening_code: "HW-BULK-REAL" });

    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        rows: [
          { opening_code: "HW-BULK-REAL", component_type: "lockset" },
          { opening_code: "HW-BULK-DOES-NOT-EXIST", component_type: "closer" },
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[1].status).toBe("error");
    expect(res.body.results[1].error).toBe("opening_code not found");
  });

  it("cannot attach hardware to another org's opening via its code, even if you guess it correctly", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    await createTestOpening(orgA.token, buildingId, { opening_code: "ORG-A-SECRET-001" });

    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ rows: [{ opening_code: "ORG-A-SECRET-001", component_type: "lockset" }] });

    expect(res.status).toBe(207);
    expect(res.body.created).toBe(0);
    expect(res.body.results[0].error).toBe("opening_code not found");
  });

  it("rejects a row with an invalid component_type before touching the database", async () => {
    const org = await signupTestOrg();
    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ rows: [{ opening_code: "ANY-CODE", component_type: "not_a_real_type" }] });

    expect(res.status).toBe(400);
  });

  it("accepts every expanded component type, including the new electrified-hardware ones", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    await createTestOpening(org.token, buildingId, { opening_code: "HW-BULK-TYPES" });

    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        rows: [
          { opening_code: "HW-BULK-TYPES", component_type: "keypad" },
          { opening_code: "HW-BULK-TYPES", component_type: "electric_strike" },
          { opening_code: "HW-BULK-TYPES", component_type: "power_transfer" },
          { opening_code: "HW-BULK-TYPES", component_type: "maglock" },
          { opening_code: "HW-BULK-TYPES", component_type: "request_to_exit_device" },
        ],
      });

    expect(res.status).toBe(207);
    expect(res.body.created).toBe(5);
  });
});
