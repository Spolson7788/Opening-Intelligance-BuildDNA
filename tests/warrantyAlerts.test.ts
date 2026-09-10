import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function addHardwareWithWarranty(token: string, openingId: string, warrantyExpiration: string) {
  const res = await request(app)
    .post("/api/hardware")
    .set("Authorization", `Bearer ${token}`)
    .send({ opening_id: openingId, component_type: "lockset", warranty_expiration: warrantyExpiration });
  return res.body;
}

describe("warranty alerts", () => {
  it("flags a part whose warranty expired 10 days ago", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await addHardwareWithWarranty(org.token, opening.id, daysFromNow(-10));

    const res = await request(app)
      .get(`/api/portfolio/warranty-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.status).toBe(200);
    expect(res.body.counts.expired).toBe(1);
    expect(res.body.alerts[0].alert_level).toBe("expired");
  });

  it("flags a part expiring in 45 days as expiring_soon (within the 90-day window)", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await addHardwareWithWarranty(org.token, opening.id, daysFromNow(45));

    const res = await request(app)
      .get(`/api/portfolio/warranty-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.counts.expiring_soon).toBe(1);
  });

  it("does NOT flag a part expiring 200 days out (well outside the 90-day window)", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await addHardwareWithWarranty(org.token, opening.id, daysFromNow(200));

    const res = await request(app)
      .get(`/api/portfolio/warranty-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.total_flagged).toBe(0);
  });

  it("does NOT flag a part with no warranty_expiration set at all", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, component_type: "hinge" });

    const res = await request(app)
      .get(`/api/portfolio/warranty-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.total_flagged).toBe(0);
  });

  it("sorts expired ahead of expiring_soon, and within a tier, soonest first", async () => {
    const org = await signupTestOrg();
    const { buildingId, propertyId } = await createPortfolioHierarchy(org.token);
    const soonOpening = await createTestOpening(org.token, buildingId, { opening_code: "WARR-SOON-001" });
    await addHardwareWithWarranty(org.token, soonOpening.id, daysFromNow(30));
    const expiredOpening = await createTestOpening(org.token, buildingId, { opening_code: "WARR-EXPIRED-001" });
    await addHardwareWithWarranty(org.token, expiredOpening.id, daysFromNow(-5));

    const res = await request(app)
      .get(`/api/portfolio/warranty-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.alerts[0].alert_level).toBe("expired");
    expect(res.body.alerts[1].alert_level).toBe("expiring_soon");
  });

  it("omitting property_id returns alerts across the whole org", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await addHardwareWithWarranty(org.token, opening.id, daysFromNow(-1));

    const res = await request(app)
      .get("/api/portfolio/warranty-alerts")
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.total_flagged).toBeGreaterThanOrEqual(1);
  });

  it("rejects a property belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { propertyId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .get(`/api/portfolio/warranty-alerts?property_id=${propertyId}`)
      .set("Authorization", `Bearer ${orgB.token}`);
    expect(res.status).toBe(403);
  });

  it("org-wide warranty alerts never include another org's parts", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId, { opening_code: "ORG-A-WARRANTY" });
    await addHardwareWithWarranty(orgA.token, opening.id, daysFromNow(-1));

    const res = await request(app)
      .get("/api/portfolio/warranty-alerts")
      .set("Authorization", `Bearer ${orgB.token}`);

    expect(res.body.alerts.find((a: any) => a.opening_code === "ORG-A-WARRANTY")).toBeUndefined();
  });
});
