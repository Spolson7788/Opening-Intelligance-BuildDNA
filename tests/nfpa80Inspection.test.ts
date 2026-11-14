import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { assessFireDoorChecklist, generalPassCarriesChecklist, NFPA80_ITEMS } from "../src/services/nfpa80Checklist";
import { resolveInspectionType } from "../field-app/src/lib/nfpa80Items";
import { fireDoorOutcome } from "../field-app/src/lib/nfpa80Items";
import { failingFireDoorFields, passingFireDoorFields } from "./nfpa80Fixture";
import { setEmailProviderForTests, type OutboundEmail } from "../src/services/email";
import { dashboardInspectionLink } from "../src/services/inspectionReportLink";
import { linkedInspectionId } from "../dashboard/src/lib/inspectionLink";
import { pool } from "../src/db/pool";
import { inflateSync } from "node:zlib";

describe("NFPA 80 checklist", () => {
  it("names 13 original items and rejects an unfinished or photo-less failure", () => {
    expect(NFPA80_ITEMS.find((item) => item.key === "clearances")?.text).toContain("1/8 inch");
    expect(NFPA80_ITEMS.find((item) => item.key === "signage")?.text).toContain("5%");
    expect(NFPA80_ITEMS).toHaveLength(13);
    expect(NFPA80_ITEMS.map((item) => item.section)).toEqual([
      "5.2.4.2(1)", "5.2.4.2(2)", "5.2.4.2(3)", "5.2.4.2(4)", "5.2.4.2(5)", "5.2.4.2(6)", "5.2.4.2(7)",
      "5.2.4.2(8)", "5.2.4.2(9)", "5.2.4.2(10)", "5.2.4.2(11)", "5.2.4.2(12)", "5.2.4.2(13)",
    ]);
    expect(assessFireDoorChecklist({ status: "complete", items: {} }, "Ada", "Inspector", "FD-1").ok).toBe(false);
    const failed = failingFireDoorFields();
    const items = { ...(failed.checklist_result.items as Record<string, any>) };
    delete items.labels.photo_base64;
    expect(assessFireDoorChecklist({ status: "complete", items }, "Ada", "Inspector", "FD-1").ok).toBe(false);
    const allNa = Object.fromEntries(NFPA80_ITEMS.map((item) => [item.key, { result: "na" }]));
    const naResult = assessFireDoorChecklist({ status: "complete", items: allNa }, "Ada", "Inspector", "FD-1");
    expect(naResult.ok).toBe(false);
    if (!naResult.ok) expect(naResult.error).toBe("checklist_incomplete");
    const coreNa = Object.fromEntries(NFPA80_ITEMS.map((item) => [item.key, { result: item.allowsNa ? "na" : "pass" }]));
    coreNa.labels = { result: "na" };
    expect(assessFireDoorChecklist({ status: "complete", items: coreNa }, "Ada", "Inspector", "FD-1").ok).toBe(false);
    expect(fireDoorOutcome(allNa).ok).toBe(false);
    expect(fireDoorOutcome(Object.fromEntries(NFPA80_ITEMS.map((item) => [item.key, { result: item.allowsNa ? "na" : "pass" }]))).ok).toBe(true);
    expect(resolveInspectionType("general", { labels: { result: "fail" } })).toBe("fire_door_nfpa80");
    expect(resolveInspectionType("general", {})).toBe("general");
    expect(generalPassCarriesChecklist("general", true, { status: "complete", items: { labels: { result: "fail" } } })).toBe(true);
    expect(generalPassCarriesChecklist("general", true, {})).toBe(false);
    expect(generalPassCarriesChecklist("fire_door_nfpa80", true, { status: "complete" })).toBe(false);
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
    const { org, propertyId, opening: door } = await opening();
    const incomplete = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", passed: false, notes: "no checklist",
    });
    expect(incomplete.status).toBe(400);

    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...failingFireDoorFields(),
    });
    expect(created.status).toBe(201);
    expect(created.body.inspector_qualification).toBe("Fire door inspector");
    expect(created.body.inspector_license_number).toBe("FD-100");
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
    const cleared = await pool.query("SELECT request_body FROM audit_log WHERE organization_id=$1 AND action=$2", [org.organizationId, "Cleared fire door deficiency on re-inspection"]);
    expect(cleared.rows.some((row) => row.request_body.deficiency_id === deficiency.id && row.request_body.item_key === "labels" && row.request_body.result === "pass")).toBe(true);

    const pdf = await request(app).get(`/api/events/inspection-events/${created.body.id}/report.pdf`).set("Authorization", `Bearer ${org.token}`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 4).toString()).toBe("%PDF");
    const raw = pdf.body.toString("latin1");
    const streamStart = raw.indexOf("stream\n") + "stream\n".length;
    const inflated = inflateSync(Buffer.from(raw.slice(streamStart, raw.indexOf("\nendstream", streamStart)), "latin1")).toString("latin1");
    const visible = inflated.replace(/<([0-9A-Fa-f]+)>/g, (_match, hex) => Buffer.from(hex, "hex").toString("latin1"));
    expect(visible).toContain("License FD-100");
    expect(visible).toContain("5.2.4.2(1)");

    sent.length = 0;
    setEmailProviderForTests({ name: "fake", send: async (message) => { sent.push(message); return { sent: true }; } });
    const noContact = await request(app).get(`/api/events/inspection-events/${created.body.id}/email-defaults`).set("Authorization", `Bearer ${org.token}`);
    expect(noContact.body.to).toEqual([org.email]);
    const savedContact = await request(app).put(`/api/portfolio/properties/${propertyId}/contact-email`).set("Authorization", `Bearer ${org.token}`).send({ contact_email: "building@example.com" });
    expect(savedContact.status).toBe(200);
    const withContact = await request(app).get(`/api/events/inspection-events/${created.body.id}/email-defaults`).set("Authorization", `Bearer ${org.token}`);
    expect(withContact.body.to).toEqual(["building@example.com", org.email]);
    const previousBase = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "https://oi-video-workflows-staging.netlify.app";
    const mailed = await request(app).post(`/api/events/inspection-events/${created.body.id}/email`).set("Authorization", `Bearer ${org.token}`).send({ to: ["facility@example.com", org.email, "extra@example.com"] });
    process.env.APP_BASE_URL = previousBase;
    expect(mailed.status).toBe(200);
    expect(sent[0].to).toEqual(["facility@example.com", org.email, "extra@example.com"]);
    expect(sent[0].attachments?.[0].filename).toBe("fire-door-inspection.pdf");
    const dashboardLink = dashboardInspectionLink("https://oi-video-workflows-staging.netlify.app", door.id, created.body.id);
    expect(sent[0].text).toContain(dashboardLink);
    expect(sent[0].text).not.toContain("token=");
    expect(sent[0].html).not.toContain("?");
    let emailedRecipient = false;
    for (let attempt = 0; attempt < 20 && !emailedRecipient; attempt += 1) {
      const emailed = await pool.query("SELECT action, request_body FROM audit_log WHERE organization_id=$1 AND action=$2", [org.organizationId, "Emailed fire door inspection report"]);
      emailedRecipient = emailed.rows.some((row) => row.request_body.to?.includes("facility@example.com"));
      if (!emailedRecipient) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(emailedRecipient).toBe(true);

    const photoDelete = await request(app).delete(`/api/photos/${deficiency.photo_id}`).set("Authorization", `Bearer ${org.token}`);
    expect(photoDelete.status).toBe(409);
    const removed = await request(app).delete(`/api/events/inspection-events/${created.body.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(removed.status).toBe(409);
  });

  it("prefills the signer, and the sender when the signer has no email", async () => {
    const { org, propertyId, opening: door } = await opening();
    const missingLicense = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...passingFireDoorFields(), inspector_license_number: " ",
    });
    expect(missingLicense.status).toBe(400);
    expect(missingLicense.body.error).toBe("inspector_license_required");

    const signerEmail = `signer-${Date.now()}@example.com`;
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`).send({
      email: signerEmail, password: "password12345", full_name: "Signing Inspector", role: "inspector",
    });
    const login = await request(app).post("/api/auth/login").send({ email: signerEmail, password: "password12345" });
    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${login.body.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...passingFireDoorFields(),
    });
    expect(created.status).toBe(201);
    await request(app).put(`/api/portfolio/properties/${propertyId}/contact-email`).set("Authorization", `Bearer ${org.token}`).send({ contact_email: "building@example.com" });
    const defaults = await request(app).get(`/api/events/inspection-events/${created.body.id}/email-defaults`).set("Authorization", `Bearer ${org.token}`);
    expect(defaults.body.inspector_email).toBe(signerEmail);
    expect(defaults.body.to).toEqual(["building@example.com", signerEmail]);

    await pool.query("UPDATE inspection_events SET performed_by_user_id = NULL WHERE id=$1", [created.body.id]);
    const fallback = await request(app).get(`/api/events/inspection-events/${created.body.id}/email-defaults`).set("Authorization", `Bearer ${org.token}`);
    expect(fallback.body.to).toEqual(["building@example.com", org.email]);
  });

  it("does not pass an all-N/A inspection, and N/A does not clear an open deficiency", async () => {
    const { org, opening: door } = await opening();
    const allNa = {
      ...passingFireDoorFields(),
      passed: true,
      checklist_result: { status: "complete", items: Object.fromEntries(NFPA80_ITEMS.map((item) => [item.key, { result: "na" }])) },
    };
    const rejected = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...allNa,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("checklist_incomplete");

    const failedSeal = passingFireDoorFields();
    (failedSeal.checklist_result.items as Record<string, any>).gasketing = { result: "fail", note: "The seal is torn", photo_base64: failingFireDoorFields().checklist_result.items.labels.photo_base64 };
    failedSeal.passed = false;
    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...failedSeal,
    });
    expect(created.status).toBe(201);
    const detail = await request(app).get(`/api/openings/${door.id}`).set("Authorization", `Bearer ${org.token}`);
    const deficiency = detail.body.fire_door_deficiencies[0];
    expect(deficiency.item_key).toBe("gasketing");

    const markedNa = passingFireDoorFields();
    (markedNa.checklist_result.items as Record<string, any>).gasketing = { result: "na" };
    const again = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-05-01", inspection_type: "fire_door_nfpa80", ...markedNa,
    });
    expect(again.status).toBe(201);
    const afterNa = await request(app).get(`/api/openings/${door.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(afterNa.body.fire_door_deficiencies.find((row: any) => row.id === deficiency.id).status).toBe("open");
    const audits = await pool.query("SELECT request_body FROM audit_log WHERE organization_id=$1 AND action=$2", [org.organizationId, "Cleared fire door deficiency on re-inspection"]);
    expect(audits.rows.some((row) => row.request_body.deficiency_id === deficiency.id)).toBe(false);
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

  it("saves one facility copy of the report and keeps it inside that facility", async () => {
    const { org, opening: door } = await opening();
    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...passingFireDoorFields(),
    });
    expect(created.status).toBe(201);
    const managerEmail = `manager-${Date.now()}@example.com`;
    const viewerEmail = `viewer-${Date.now()}@example.com`;
    const inspectorEmail = `inspector-${Date.now()}@example.com`;
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`).send({ email: managerEmail, password: "password12345", full_name: "Facility Manager", role: "facilities_manager" });
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`).send({ email: viewerEmail, password: "password12345", full_name: "Facility Viewer", role: "viewer" });
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`).send({ email: inspectorEmail, password: "password12345", full_name: "Inspector", role: "inspector" });
    const manager = await request(app).post("/api/auth/login").send({ email: managerEmail, password: "password12345" });
    const viewer = await request(app).post("/api/auth/login").send({ email: viewerEmail, password: "password12345" });
    const inspector = await request(app).post("/api/auth/login").send({ email: inspectorEmail, password: "password12345" });
    const outsider = await signupTestOrg("Other Facility");

    const denied = await request(app).post(`/api/events/inspection-events/${created.body.id}/facility-record`).set("Authorization", `Bearer ${inspector.body.token}`);
    expect(denied.status).toBe(403);
    const first = await request(app).post(`/api/events/inspection-events/${created.body.id}/facility-record`).set("Authorization", `Bearer ${manager.body.token}`);
    expect(first.status).toBe(201);
    expect(first.body.already_saved).toBe(false);
    const second = await request(app).post(`/api/events/inspection-events/${created.body.id}/facility-record`).set("Authorization", `Bearer ${org.token}`);
    expect(second.status).toBe(200);
    expect(second.body.already_saved).toBe(true);
    expect(second.body.document.id).toBe(first.body.document.id);
    const listed = await request(app).get(`/api/documents/by-opening/${door.id}`).set("Authorization", `Bearer ${viewer.body.token}`);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(first.body.document.id);
    expect(JSON.stringify(listed.body)).not.toContain("content");
    const file = await request(app).get(`/api/documents/${first.body.document.id}/file`).set("Authorization", `Bearer ${viewer.body.token}`);
    expect(file.status).toBe(200);
    expect(file.body.slice(0, 4).toString()).toBe("%PDF");
    expect((await request(app).get(`/api/documents/${first.body.document.id}/file`).set("Authorization", `Bearer ${outsider.token}`)).status).toBe(404);
    expect((await request(app).post(`/api/events/inspection-events/${created.body.id}/facility-record`).set("Authorization", `Bearer ${outsider.token}`)).status).toBe(404);
    const copies = await pool.query("SELECT id FROM documents WHERE inspection_event_id=$1", [created.body.id]);
    expect(copies.rowCount).toBe(1);
    const audit = await pool.query("SELECT action FROM audit_log WHERE organization_id=$1 AND action=$2", [org.organizationId, "Saved fire door inspection to facility records"]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("lets the API role write a deficiency, update the inspection, and store the report", async () => {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN CREATE ROLE oi_pr2_api NOLOGIN; END IF; END $$");
    const { org, opening: door } = await opening();
    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...failingFireDoorFields(),
    });
    expect(created.status).toBe(201);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP POLICY IF EXISTS oi_pr2_api_insert ON fire_door_deficiencies");
      await client.query("SET LOCAL ROLE oi_pr2_api");
      await expect(client.query(
        `INSERT INTO fire_door_deficiencies (organization_id, opening_id, inspection_event_id, item_key, note)
         VALUES ($1,$2,$3,'labels','stuck')`,
        [org.organizationId, door.id, created.body.id],
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    await pool.query(readFileSync("migrations/20261108171000_fire_door_api_policies.sql", "utf8"));
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL ROLE oi_pr2_api");
      const deficiency = await writer.query(
        `INSERT INTO fire_door_deficiencies (organization_id, opening_id, inspection_event_id, item_key, note)
         VALUES ($1,$2,$3,'labels','stuck') RETURNING id`,
        [org.organizationId, door.id, created.body.id],
      );
      expect(deficiency.rowCount).toBe(1);
      const updated = await writer.query("UPDATE inspection_events SET notes = notes WHERE id=$1 RETURNING id", [created.body.id]);
      expect(updated.rowCount).toBe(1);
      const document = await writer.query(
        `INSERT INTO documents (opening_id, document_type, title, storage_url, inspection_event_id, content, content_type)
         VALUES ($1,'inspection_report','Fire door inspection','oi-record://test',$2,$3,'application/pdf') RETURNING id`,
        [door.id, created.body.id, Buffer.from("%PDF")],
      );
      expect(document.rowCount).toBe(1);
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      writer.release();
    }
  });

  it("serves a stored inspection failure photo without putting the bytes in the opening", async () => {
    const { org, opening: door } = await opening();
    const created = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "fire_door_nfpa80", ...failingFireDoorFields(),
    });
    expect(created.status).toBe(201);
    const detail = await request(app).get(`/api/openings/${door.id}`).set("Authorization", `Bearer ${org.token}`);
    const photo = detail.body.photos[0];
    expect(photo.storage_url.startsWith("inline:")).toBe(true);
    expect(photo.inline_bytes).toBeUndefined();
    const file = await request(app).get(`/api/photos/${photo.id}/content`).set("Authorization", `Bearer ${org.token}`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.body[0]).toBe(0x89);
    expect((await request(app).get(`/api/photos/${photo.id}/content`)).status).toBe(401);
    expect(linkedInspectionId(`#inspection-${created.body.id}`)).toBe(created.body.id);
    expect(linkedInspectionId("#inspection-not-an-id")).toBeNull();
  });

  it("rejects a passed general inspection that still carries checklist answers", async () => {
    const { org, opening: door } = await opening();
    const rejected = await request(app).post("/api/events/inspection-events").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: door.id, event_date: "2026-04-01", inspection_type: "general", passed: true,
      checklist_result: { status: "complete", items: { labels: { result: "fail", note: "Label missing" } } },
      signed_by_name: "Ada",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("inspection_type_mismatch");
    const listed = await request(app).get(`/api/openings/${door.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(listed.body.inspection_events).toHaveLength(0);
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
