import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { setEmailProviderForTests, resendProvider, type OutboundEmail } from "../src/services/email";
import { decodePurchasingSheet, sendPurchasingPackage } from "../src/services/purchasingSend";
import { sheetKind } from "../field-app/src/lib/purchasingSheet";
import { pool } from "../src/db/pool";

const TINY_PDF = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF").toString("base64");

async function invite(adminToken: string, role: string) {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await request(app).post("/api/auth/register").set("Authorization", `Bearer ${adminToken}`).send({ email, password: "password12345", full_name: role, role });
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  return login.body.token as string;
}

async function hardware(token: string, openingId: string) {
  const res = await request(app).post("/api/hardware").set("Authorization", `Bearer ${token}`).send({ opening_id: openingId, component_type: "closer" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("send to purchasing", () => {
  const sent: OutboundEmail[] = [];
  afterEach(() => { setEmailProviderForTests(null); delete process.env.PURCHASING_EMAIL_MAX_ATTACHMENT_BYTES; });

  function capture() {
    sent.length = 0;
    setEmailProviderForTests({ name: "fake", send: async (message) => { sent.push(message); return { sent: true }; } });
  }

  it("attaches a small uploaded PDF and records the send on the opening", async () => {
    capture();
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    const email = await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "buy@example.com" });
    expect(email.status).toBe(200);

    const res = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId, note: "Need the closer",
      uploads: [{ filename: "closer-cut-sheet.pdf", content_base64: TINY_PDF }],
    });
    expect(res.status).toBe(201);
    expect(res.body.delivery_mode).toBe("attachments");
    expect(res.body.sent_to).toBe("buy@example.com");
    expect(sent[0].attachments?.[0].filename).toBe("closer-cut-sheet.pdf");

    const detail = await request(app).get(`/api/openings/${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(detail.body.purchasing_sends[0].sent_to).toBe("buy@example.com");
    expect(detail.body.purchasing_sends[0].note).toBe("Need the closer");
  });

  it("uses the branch that covers the job, not the technician's home branch", async () => {
    capture();
    const org = await signupTestOrg();
    const { propertyId, buildingId } = await createPortfolioHierarchy(org.token);
    await pool.query("UPDATE properties SET state_code='AZ', county_fips='04013' WHERE id=$1", [propertyId]);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "company@example.com" });
    const west = crypto.randomUUID();
    const east = crypto.randomUUID();
    await request(app).put(`/api/branches/${west}`).set("Authorization", `Bearer ${org.token}`).send({
      name: "West", default_state: "AZ", default_territory: null, is_active: true, purchasing_email: "west@example.com",
    });
    await request(app).put(`/api/branches/${east}`).set("Authorization", `Bearer ${org.token}`).send({
      name: "East", default_state: "AZ", default_territory: null, is_active: true, purchasing_email: "east@example.com",
    });
    await pool.query("INSERT INTO company_branch_areas (branch_id, state_code, county_fips) VALUES ($1,'AZ','04013')", [west]);
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${org.token}`);
    await request(app).put(`/api/branches/assignments/${me.body.id}`).set("Authorization", `Bearer ${org.token}`).send({ branch_id: east });

    const preview = await request(app).get(`/api/purchasing/destination?opening_id=${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(preview.body).toMatchObject({ ready: true, to: "west@example.com", source: "branch", branch: { id: west, name: "West" } });
    const res = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId,
      uploads: [{ filename: "install.pdf", content_base64: TINY_PDF }],
    });
    expect(res.status).toBe(201);
    expect(res.body.sent_to).toBe(preview.body.to);
  });

  it("links an existing opening document and a PDF that is over the attachment limit", async () => {
    capture();
    process.env.PURCHASING_EMAIL_MAX_ATTACHMENT_BYTES = "1500";
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "buy@example.com" });
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${org.token}`);
    const doc = await pool.query(
      "INSERT INTO documents (opening_id, document_type, title, storage_url, uploaded_by_user_id) VALUES ($1,'other','Cut sheet','https://files.example.test/cut.pdf',$2) RETURNING id",
      [opening.id, me.body.id],
    );
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(2000, 65)]).toString("base64");
    const res = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId,
      document_ids: [doc.rows[0].id],
      uploads: [{ filename: "large.pdf", content_base64: big }],
    });
    expect(res.status).toBe(201);
    expect(res.body.delivery_mode).toBe("links");
    expect(sent[0].text).toContain("https://files.example.test/cut.pdf");
    expect(sent[0].text).toContain(`/api/purchasing/sends/${res.body.id}/files/`);
    expect(sent[0].attachments).toBeUndefined();
    const fileId = sent[0].text.match(/files\/([0-9a-f-]{36})/)?.[1];
    const download = await request(app).get(`/api/purchasing/sends/${res.body.id}/files/${fileId}`).set("Authorization", `Bearer ${org.token}`);
    expect(download.status).toBe(200);
    expect(download.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("refuses a send with no document, no purchasing email, another company, or a viewer, and allows an inspector", async () => {
    capture();
    const org = await signupTestOrg();
    const other = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    const upload = { opening_id: opening.id, hardware_component_id: componentId, uploads: [{ filename: "a.pdf", content_base64: TINY_PDF }] };

    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({ opening_id: opening.id, hardware_component_id: componentId })).status).toBe(400);
    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send(upload)).body.error).toBe("purchasing_email_missing");
    await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "buy@example.com" });
    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${other.token}`).send(upload)).status).toBe(403);
    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${await invite(org.token, "viewer")}`).send(upload)).status).toBe(403);
    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${await invite(org.token, "inspector")}`).send(upload)).status).toBe(201);
    const tech = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${await invite(org.token, "technician")}`).send(upload);
    expect(tech.status).toBe(201);
  });

  it("accepts an iPhone PDF with no extension and a photo of the sheet", async () => {
    capture();
    const org = await signupTestOrg();
    const manager = await invite(org.token, "facilities_manager");
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    expect((await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${manager}`).send({ purchasing_email: "buy@example.com" })).status).toBe(200);
    expect((await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${await invite(org.token, "technician")}`).send({ purchasing_email: "nope@example.com" })).status).toBe(403);
    const branchId = crypto.randomUUID();
    await request(app).put(`/api/branches/${branchId}`).set("Authorization", `Bearer ${org.token}`).send({
      name: "West", default_state: "AZ", default_territory: null, is_active: true,
    });
    const branchEmail = await request(app).put(`/api/purchasing/branches/${branchId}/email`).set("Authorization", `Bearer ${manager}`).send({ purchasing_email: "west@example.com" });
    expect(branchEmail.status).toBe(200);
    expect((await request(app).get("/api/purchasing/branch-emails").set("Authorization", `Bearer ${manager}`)).body.branches[0].purchasing_email).toBe("west@example.com");

    const unnamed = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId,
      uploads: [{ filename: "Cut sheet", content_base64: TINY_PDF }],
    });
    expect(unnamed.status).toBe(201);
    expect(sent.at(-1)?.attachments?.[0].filename).toBe("Cut sheet.pdf");

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");
    const photo = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId,
      uploads: [{ filename: "sheet", content_base64: jpeg }],
    });
    expect(photo.status).toBe(201);
    expect(sent.at(-1)?.attachments?.[0].filename).toBe("sheet.jpg");
    const stored = await pool.query("SELECT content_type FROM purchasing_send_files WHERE send_id=$1", [photo.body.id]);
    expect(stored.rows[0].content_type).toBe("image/jpeg");

    const refused = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId,
      uploads: [{ filename: "notes.txt", content_base64: Buffer.from("not a sheet").toString("base64") }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("sheet_unreadable");
    expect(sheetKind(Uint8Array.from(Buffer.from(TINY_PDF, "base64")))).toBe("pdf");
    expect(decodePurchasingSheet(Buffer.from("hello").toString("base64"))).toBeNull();
  });

  it("still reports the email failure when cleanup is not permitted", async () => {
    setEmailProviderForTests({ name: "fake", send: async () => ({ sent: false, reason: "email_not_configured" }) });
    const db = {
      query: async (sql: string) => {
        if (sql.includes("state_code")) return { rows: [{ state_code: null, county_fips: null, org_email: "buy@example.com" }] };
        if (sql.includes("AS declared")) return { rows: [{ declared: false }] };
        if (sql.includes("INSERT INTO purchasing_sends")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
        if (sql.includes("INSERT INTO purchasing_send_files")) return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
        if (sql.startsWith("DELETE")) {
          const denied = new Error("permission denied for table purchasing_sends");
          throw Object.assign(denied, { code: "42501" });
        }
        return { rows: [] };
      },
    };
    const result = await sendPurchasingPackage(db, {
      openingId: "33333333-3333-4333-8333-333333333333",
      hardwareComponentId: "44444444-4444-4444-8444-444444444444",
      organizationId: "55555555-5555-4555-8555-555555555555",
      userId: "66666666-6666-4666-8666-666666666666",
      documentIds: [],
      referenceSha256s: [],
      includeApproved: false,
      uploads: [{ filename: "Cut sheet", content_base64: TINY_PDF }],
    });
    expect(result).toEqual({ error: "email_not_configured", status: 503 });
  });

  it("lets the API role update a file link, delete a send, and set the company email", async () => {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN CREATE ROLE oi_pr2_api NOLOGIN; END IF; END $$");
    await pool.query(readFileSync("migrations/20261108180000_purchasing_api_policies.sql", "utf8"));
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "buy@example.com" });
    const sentRow = await pool.query(
      `INSERT INTO purchasing_sends (organization_id, opening_id, hardware_component_id, sent_by_user_id, sent_to, delivery_mode)
       VALUES ($1,$2,$3,$4,'buy@example.com','links') RETURNING id`,
      [org.organizationId, opening.id, componentId, (await request(app).get("/api/auth/me").set("Authorization", `Bearer ${org.token}`)).body.id],
    );
    const file = await pool.query(
      `INSERT INTO purchasing_send_files (send_id, filename, content_type, byte_size) VALUES ($1,'sheet.pdf','application/pdf',0) RETURNING id`,
      [sentRow.rows[0].id],
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE oi_pr2_api");
      const updated = await client.query("UPDATE purchasing_send_files SET link_url='https://example.test/sheet' WHERE id=$1 RETURNING id", [file.rows[0].id]);
      expect(updated.rowCount).toBe(1);
      const removedFiles = await client.query("DELETE FROM purchasing_send_files WHERE send_id=$1", [sentRow.rows[0].id]);
      expect(removedFiles.rowCount).toBe(1);
      const removed = await client.query("DELETE FROM purchasing_sends WHERE id=$1", [sentRow.rows[0].id]);
      expect(removed.rowCount).toBe(1);
      const email = await client.query("UPDATE organizations SET purchasing_email='desk@example.com' WHERE id=$1 RETURNING purchasing_email", [org.organizationId]);
      expect(email.rows[0].purchasing_email).toBe("desk@example.com");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("falls back to the company address, and blocks an unknown, ambiguous, or unauthorized branch", async () => {
    capture();
    const org = await signupTestOrg();
    const other = await signupTestOrg();
    const { propertyId, buildingId } = await createPortfolioHierarchy(org.token);
    await pool.query("UPDATE properties SET state_code='AZ', county_fips='04013' WHERE id=$1", [propertyId]);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "company@example.com" });
    const covered = crypto.randomUUID();
    const otherCovered = crypto.randomUUID();
    const outsider = crypto.randomUUID();
    for (const [id, name, email] of [[covered, "West", null], [otherCovered, "Central", "central@example.com"], [outsider, "Other", "other@example.com"]] as const) {
      await request(app).put(`/api/branches/${id}`).set("Authorization", `Bearer ${org.token}`).send({
        name, default_state: "AZ", default_territory: null, is_active: true, purchasing_email: email,
      });
    }
    await request(app).put(`/api/branches/${outsider}`).set("Authorization", `Bearer ${other.token}`).send({
      name: "Foreign", default_state: "AZ", default_territory: null, is_active: true, purchasing_email: "foreign@example.com",
    });
    await pool.query("INSERT INTO company_branch_areas (branch_id, state_code, county_fips) VALUES ($1,'AZ','04013'),($2,'AZ',NULL)", [covered, otherCovered]);

    const choice = await request(app).get(`/api/purchasing/destination?opening_id=${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(choice.status).toBe(200);
    expect(choice.body.error).toBe("branch_choice_required");
    expect(choice.body.choices.map((branch: { id: string }) => branch.id).sort()).toEqual([covered, otherCovered].sort());
    const blocked = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId, uploads: [{ filename: "a.pdf", content_base64: TINY_PDF }],
    });
    expect(blocked.body.error).toBe("branch_choice_required");
    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId, branch_id: outsider,
      uploads: [{ filename: "a.pdf", content_base64: TINY_PDF }],
    })).body.error).toBe("branch_not_authorized");
    expect((await request(app).get(`/api/purchasing/destination?opening_id=${opening.id}`).set("Authorization", `Bearer ${other.token}`)).status).toBe(403);

    const fallback = await request(app).get(`/api/purchasing/destination?opening_id=${opening.id}&branch_id=${covered}`).set("Authorization", `Bearer ${org.token}`);
    expect(fallback.body).toMatchObject({ ready: true, to: "company@example.com", source: "company", branch: { id: covered, name: "West" } });
    const sentFallback = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId, branch_id: covered,
      uploads: [{ filename: "a.pdf", content_base64: TINY_PDF }],
    });
    expect(sentFallback.status).toBe(201);
    expect(sentFallback.body.sent_to).toBe(fallback.body.to);

    await pool.query("DELETE FROM company_branch_areas WHERE branch_id=$1", [otherCovered]);
    await pool.query("UPDATE organizations SET purchasing_email=NULL WHERE id=$1", [org.organizationId]);
    await pool.query("UPDATE company_branches SET purchasing_email=NULL WHERE id=$1", [covered]);
    const missing = await request(app).get(`/api/purchasing/destination?opening_id=${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(missing.body.error).toBe("purchasing_email_missing");

    await pool.query("DELETE FROM company_branch_areas WHERE branch_id=$1", [covered]);
    await pool.query("INSERT INTO company_branch_areas (branch_id, state_code, county_fips) VALUES ($1,'NV',NULL)", [covered]);
    const unknown = await request(app).get(`/api/purchasing/destination?opening_id=${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(unknown.body.error).toBe("branch_unknown");
    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId, uploads: [{ filename: "a.pdf", content_base64: TINY_PDF }],
    })).body.error).toBe("branch_unknown");
  });

  it("keeps a company with no branch areas on the company purchasing address", async () => {
    capture();
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "company@example.com" });
    const branchId = crypto.randomUUID();
    await request(app).put(`/api/branches/${branchId}`).set("Authorization", `Bearer ${org.token}`).send({
      name: "Home", default_state: "AZ", default_territory: null, is_active: true, purchasing_email: "home@example.com",
    });
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${org.token}`);
    await request(app).put(`/api/branches/assignments/${me.body.id}`).set("Authorization", `Bearer ${org.token}`).send({ branch_id: branchId });
    const preview = await request(app).get(`/api/purchasing/destination?opening_id=${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(preview.body).toMatchObject({ ready: true, to: "company@example.com", source: "company", branch: null });
    const res = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId, uploads: [{ filename: "a.pdf", content_base64: TINY_PDF }],
    });
    expect(res.body.sent_to).toBe("company@example.com");
    expect((await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "not-an-email" })).status).toBe(400);
  });

  it("puts attachments on the Resend request body", async () => {
    const bodies: string[] = [];
    const provider = resendProvider("test-key", "Opening <mail@example.com>", async (_url, init) => { bodies.push(init.body); return { ok: true, status: 200 }; });
    const result = await provider.send({ to: "buy@example.com", subject: "Sheets", text: "See attached", html: "<p>See attached</p>", attachments: [{ filename: "a.pdf", contentBase64: "QQ==" }] });
    expect(result.sent).toBe(true);
    expect(JSON.parse(bodies[0]).attachments[0]).toEqual({ filename: "a.pdf", content: "QQ==" });
  });
});
