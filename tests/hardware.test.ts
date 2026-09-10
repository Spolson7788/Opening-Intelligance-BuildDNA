import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("hardware", () => {
  it("adds a hardware component to an opening", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset", manufacturer: "Cal-Royal", model_number: "ND80BD" });
    expect(res.status).toBe(201);
    expect(res.body.manufacturer).toBe("Cal-Royal");
  });

  it("rejects adding hardware to an opening that doesn't belong to the caller", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ opening_id: opening.id, component_type: "lockset" });
    expect(res.status).toBe(403);
  });

  it("searches hardware portfolio-wide by manufacturer and install date", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const openingOld = await createTestOpening(org.token, buildingId, { opening_code: "OLD-001" });
    const openingNew = await createTestOpening(org.token, buildingId, { opening_code: "NEW-001" });

    await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: openingOld.id, component_type: "cylinder", manufacturer: "Cal-Royal", install_date: "2017-03-01" });
    await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: openingNew.id, component_type: "cylinder", manufacturer: "Cal-Royal", install_date: "2022-06-01" });
    await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: openingOld.id, component_type: "cylinder", manufacturer: "Allegion", install_date: "2016-01-01" });

    const res = await request(app)
      .get("/api/hardware?manufacturer=Cal-Royal&installed_before=2019-01-01")
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.length).toBe(1);
    expect(res.body[0].manufacturer).toBe("Cal-Royal");
  });

  it("updates a hardware component", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const created = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "closer", manufacturer: "Old Brand" });

    const res = await request(app)
      .patch(`/api/hardware/${created.body.id}`)
      .set("Authorization", `Bearer ${org.token}`)
      .send({ manufacturer: "Corrected Brand" });
    expect(res.status).toBe(200);
    expect(res.body.manufacturer).toBe("Corrected Brand");
  });

  it("deletes a hardware component", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const created = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "hinge" });

    const del = await request(app)
      .delete(`/api/hardware/${created.body.id}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(del.status).toBe(204);

    const list = await request(app)
      .get(`/api/hardware/by-opening/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(list.body.length).toBe(0);
  });

  it("stores cost and supplier info alongside a hardware part, so it's all in one place", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        component_type: "access_control_reader",
        manufacturer: "HID",
        model_number: "R40-CL",
        unit_cost: 425.99,
        supplier_name: "Southwest Security Supply",
        supplier_contact: "(602) 555-0134, orders@swsecurity.example",
      });

    expect(res.status).toBe(201);
    expect(res.body.unit_cost).toBe(425.99); // exercises the same numeric-string bug class fixed earlier in this project
    expect(res.body.supplier_name).toBe("Southwest Security Supply");
    expect(res.body.supplier_contact).toBe("(602) 555-0134, orders@swsecurity.example");
  });

  it("updates cost and supplier info via PATCH", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const created = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "closer" });

    const res = await request(app)
      .patch(`/api/hardware/${created.body.id}`)
      .set("Authorization", `Bearer ${org.token}`)
      .send({ unit_cost: 189.5, supplier_name: "Desert Door Hardware" });

    expect(res.status).toBe(200);
    expect(res.body.unit_cost).toBe(189.5);
    expect(res.body.supplier_name).toBe("Desert Door Hardware");
  });

  it("unit_cost is a real number in the API response, not a string", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "hinge", unit_cost: 12 });

    expect(typeof res.body.unit_cost).toBe("number");
  });

  // Regression-style test for the actual point of this feature: every part
  // gets a permanent tracker ID automatically — no client can skip it,
  // supply their own, or get a duplicate.
  it("assigns a unique tracker_id automatically, in the TRK-XXXXXXXX format", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset" });

    expect(res.body.tracker_id).toMatch(/^TRK-[0-9A-F]{8}$/);
  });

  it("a client-supplied tracker_id is ignored — it's always server-generated", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset", tracker_id: "TRK-HACKED0" });

    expect(res.body.tracker_id).not.toBe("TRK-HACKED0");
    expect(res.body.tracker_id).toMatch(/^TRK-[0-9A-F]{8}$/);
  });

  it("two parts on the same opening get two different tracker_ids", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const first = await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset" });
    const second = await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "closer" });

    expect(first.body.tracker_id).not.toBe(second.body.tracker_id);
  });

  it("defaults shipment_status to not_shipped when unspecified", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset" });

    expect(res.body.shipment_status).toBe("not_shipped");
  });

  it("stores full shipment tracking info and can update it as a part moves through transit", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const created = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        component_type: "lockset",
        serial_number: "SC-88213-A",
        carrier: "ups",
        tracking_number: "1Z999AA10123456784",
        shipment_status: "shipped",
        expected_delivery_date: "2026-08-10",
        shipped_date: "2026-08-05",
      });
    expect(created.body.shipment_status).toBe("shipped");
    expect(created.body.tracking_number).toBe("1Z999AA10123456784");

    const delivered = await request(app)
      .patch(`/api/hardware/${created.body.id}`)
      .set("Authorization", `Bearer ${org.token}`)
      .send({ shipment_status: "delivered", delivered_date: "2026-08-09" });

    expect(delivered.status).toBe(200);
    expect(delivered.body.shipment_status).toBe("delivered");
    expect(delivered.body.delivered_date).toContain("2026-08-09");
  });

  it("rejects an invalid shipment_status", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/hardware")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "lockset", shipment_status: "teleporting" });

    expect(res.status).toBe(400);
  });

  it("bulk hardware import also assigns a unique tracker_id to every row", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId, { opening_code: "TRACKER-BULK-001" });

    const res = await request(app)
      .post("/api/hardware/bulk-import")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        rows: [
          { opening_code: "TRACKER-BULK-001", component_type: "lockset", carrier: "fedex", tracking_number: "784509876123" },
          { opening_code: "TRACKER-BULK-001", component_type: "closer" },
        ],
      });

    expect(res.body.created).toBe(2);

    const list = await request(app)
      .get(`/api/hardware/by-opening/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(list.body.length).toBe(2);
    const trackerIds = list.body.map((h: any) => h.tracker_id);
    expect(trackerIds[0]).toMatch(/^TRK-[0-9A-F]{8}$/);
    expect(trackerIds[1]).toMatch(/^TRK-[0-9A-F]{8}$/);
    expect(trackerIds[0]).not.toBe(trackerIds[1]);
  });
});
