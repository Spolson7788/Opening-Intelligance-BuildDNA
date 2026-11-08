import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { setEmailProviderForTests, resendProvider, type OutboundEmail } from "../src/services/email";
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

  it("uses the branch purchasing email when the sender is assigned to that branch", async () => {
    capture();
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const componentId = await hardware(org.token, opening.id);
    await request(app).put("/api/purchasing/company-email").set("Authorization", `Bearer ${org.token}`).send({ purchasing_email: "company@example.com" });
    const branchId = crypto.randomUUID();
    const branch = await request(app).put(`/api/branches/${branchId}`).set("Authorization", `Bearer ${org.token}`).send({
      name: "West", default_state: "AZ", default_territory: null, is_active: true, purchasing_email: "branch@example.com",
    });
    expect(branch.status).toBe(200);
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${org.token}`);
    const assignment = await request(app).put(`/api/branches/assignments/${me.body.id}`).set("Authorization", `Bearer ${org.token}`).send({ branch_id: branchId });
    expect(assignment.status).toBe(200);

    const res = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, hardware_component_id: componentId,
      uploads: [{ filename: "install.pdf", content_base64: TINY_PDF }],
    });
    expect(res.status).toBe(201);
    expect(res.body.sent_to).toBe("branch@example.com");
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

  it("refuses a send with no document, no purchasing email, another company, a viewer, or an inspector", async () => {
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
    expect((await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${await invite(org.token, "inspector")}`).send(upload)).status).toBe(403);
    const tech = await request(app).post("/api/purchasing/send").set("Authorization", `Bearer ${await invite(org.token, "technician")}`).send(upload);
    expect(tech.status).toBe(201);
  });

  it("puts attachments on the Resend request body", async () => {
    const bodies: string[] = [];
    const provider = resendProvider("test-key", "Opening <mail@example.com>", async (_url, init) => { bodies.push(init.body); return { ok: true, status: 200 }; });
    const result = await provider.send({ to: "buy@example.com", subject: "Sheets", text: "See attached", html: "<p>See attached</p>", attachments: [{ filename: "a.pdf", contentBase64: "QQ==" }] });
    expect(result.sent).toBe(true);
    expect(JSON.parse(bodies[0]).attachments[0]).toEqual({ filename: "a.pdf", content: "QQ==" });
  });
});
