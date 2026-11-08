import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { assessFireDoorChecklist, NFPA80_ITEMS } from "../src/services/nfpa80Checklist";
import { failingFireDoorFields, passingFireDoorFields } from "./nfpa80Fixture";
import { setEmailProviderForTests, type OutboundEmail } from "../src/services/email";
import { pool } from "../src/db/pool";

describe("NFPA 80 checklist", () => {
  it("names 13 original items and rejects an unfinished or photo-less failure", () => {
    expect(NFPA80_ITEMS).toHaveLength(13);
    expect(NFPA80_ITEMS.map((item) => item.section)).toEqual([
      "5.2.3.1", "5.2.3.2", "5.2.3.3", "5.2.3.4", "5.2.3.5", "5.2.3.6", "5.2.3.7",
      "5.2.3.8", "5.2.3.9", "5.2.3.10", "5.2.3.11", "5.2.3.12", "5.2.3.13",
    ]);
    expect(assessFireDoorChecklist({ status: "complete", items: {} }, "Ada", "Inspector").ok).toBe(false);
    const failed = failingFireDoorFields();
    const items = { ...(failed.checklist_result.items as Record<string, any>) };
    delete items.labels.photo_base64;
    expect(assessFireDoorChecklist({ status: "complete", items }, "Ada", "Inspector").ok).toBe(false);
  });
});

describe("NFPA 80 fire door inspection", () => {
  const sent: OutboundEmail[] = [];
  afterEach(() => setEmailProviderForTests(null));

  async function opening() {
    const org = await signupTestOrg();
    const hierarchy = await createPortfolioHierarchy(org.token);
    const created = await createTestOpening(org.token, hierarchy.buildingId, { fire_rated: true });
    return { org, ...hierarchy, opening: created };
  }

  it("stores a failed item, requires a repair, then clears it on reinspection", async () => {
    const { org, opening: door } = await opening();
    const incomplete = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", passed: false, notes: "no checklist",
    });
    expect(incomplete.status).toBe(400);

    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...failingFireDoorFields(),
    });
    expect(created.status).toBe(201);
    expect(created.body.inspector_qualification).toBe("Fire door inspector");
    const detail = await request(app).get(`/api/openings/${door.id}`).set("Authorization", `Bearer ${org.token}`);
    const deficiency = detail.body.fire_door_deficiencies[0];
    expect(deficiency.status).toBe("open");
    expect(deficiency.photo_id).toBeTruthy();

    const repair = await request(app).post(`/api/events/fire-door-deficiencies/${deficiency.id}/repair`).set("Authorization", `Bearer ${org.token}`).send({ repair_note: "Label replaced" });
    expect(repair.status).toBe(200);
    expect(repair.body.status).toBe("repaired");

    const again = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-05-01", inspection_type: "fire_door_nfpa80", ...passingFireDoorFields(),
    });
    expect(again.status).toBe(201);
    const after = await request(app).get(`/api/openings/${door.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(after.body.fire_door_deficiencies.find((row: any) => row.id === deficiency.id).status).toBe("reinspected");

    const pdf = await request(app).get(`/api/events/inspection-events/${created.body.id}/report.pdf`).set("Authorization", `Bearer ${org.token}`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 4).toString()).toBe("%PDF");

    sent.length = 0;
    setEmailProviderForTests({ name: "fake", send: async (message) => { sent.push(message); return { sent: true }; } });
    const mailed = await request(app).post(`/api/events/inspection-events/${created.body.id}/email`).set("Authorization", `Bearer ${org.token}`).send({ to: "facility@example.com" });
    expect(mailed.status).toBe(200);
    expect(sent[0].to).toBe("facility@example.com");
    expect(sent[0].attachments?.[0].filename).toBe("fire-door-inspection.pdf");

    const photoDelete = await request(app).delete(`/api/photos/${deficiency.photo_id}`).set("Authorization", `Bearer ${org.token}`);
    expect(photoDelete.status).toBe(409);
    const removed = await request(app).delete(`/api/events/inspection-events/${created.body.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(removed.status).toBe(409);
  });

  it("counts only a completed fire door inspection for annual alerts", async () => {
    const { org, propertyId, opening: door } = await opening();
    await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: new Date().toISOString().slice(0, 10), inspection_type: "general", passed: true,
    });
    const stillDue = await request(app).get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`).set("Authorization", `Bearer ${org.token}`);
    expect(stillDue.body.counts.never_inspected).toBe(1);

    await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: new Date().toISOString().slice(0, 10), inspection_type: "fire_door_nfpa80", ...passingFireDoorFields(),
    });
    const current = await request(app).get(`/api/portfolio/compliance-alerts?property_id=${propertyId}`).set("Authorization", `Bearer ${org.token}`);
    expect(current.body.total_flagged).toBe(0);
    expect(current.body.counts.never_inspected).toBe(0);

    const report = await request(app).get(`/api/export/compliance-report.pdf?property_id=${propertyId}`).set("Authorization", `Bearer ${org.token}`);
    expect(report.status).toBe(200);
    expect(report.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("allows deletion only after the three-year hold", async () => {
    const { org, opening: door } = await opening();
    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-01-01", inspection_type: "general", passed: true,
    });
    expect((await request(app).delete(`/api/events/inspection-events/${created.body.id}`).set("Authorization", `Bearer ${org.token}`)).status).toBe(409);
    await pool.query("UPDATE inspection_events SET created_at = now() - interval '4 years' WHERE id=$1", [created.body.id]);
    expect((await request(app).delete(`/api/events/inspection-events/${created.body.id}`).set("Authorization", `Bearer ${org.token}`)).status).toBe(204);
  });
});
