import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("document storage", () => {
  it("presign accepts a valid PDF content type", async () => {
    const org = await signupTestOrg();
    const { propertyId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .post("/api/documents/presign")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ property_id: propertyId, content_type: "application/pdf" });

    expect([200, 503]).toContain(res.status);
  });

  it("presign rejects an unsupported content type (e.g. an image)", async () => {
    const org = await signupTestOrg();
    const { propertyId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .post("/api/documents/presign")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ property_id: propertyId, content_type: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_content_type");
  });

  it("presign requires at least one of property_id or opening_id", async () => {
    const org = await signupTestOrg();

    const res = await request(app)
      .post("/api/documents/presign")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ content_type: "application/pdf" });

    expect(res.status).toBe(400);
  });

  it("can attach a document to a property alone (no opening)", async () => {
    const org = await signupTestOrg();
    const { propertyId } = await createPortfolioHierarchy(org.token);

    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        property_id: propertyId,
        document_type: "insurance",
        title: "2026 Property Insurance Policy",
        storage_url: "https://example-bucket.s3.amazonaws.com/org/documents/policy.pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.property_id).toBe(propertyId);
    expect(res.body.opening_id).toBeNull();
  });

  it("can attach a document to a specific opening", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        document_type: "warranty",
        title: "Schlage Lockset Warranty",
        storage_url: "https://example-bucket.s3.amazonaws.com/org/documents/warranty.pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.opening_id).toBe(opening.id);
  });

  it("rejects creating a document with neither property_id nor opening_id", async () => {
    const org = await signupTestOrg();

    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ document_type: "other", title: "Orphan Document", storage_url: "https://example.com/x.pdf" });

    expect(res.status).toBe(400);
  });

  it("lists documents attached to a property", async () => {
    const org = await signupTestOrg();
    const { propertyId } = await createPortfolioHierarchy(org.token);
    await request(app).post("/api/documents").set("Authorization", `Bearer ${org.token}`)
      .send({ property_id: propertyId, document_type: "insurance", title: "Doc A", storage_url: "https://example.com/a.pdf" });

    const res = await request(app).get(`/api/documents/by-property/${propertyId}`).set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe("Doc A");
  });

  it("lists documents attached to an opening", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await request(app).post("/api/documents").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, document_type: "warranty", title: "Doc B", storage_url: "https://example.com/b.pdf" });

    const res = await request(app).get(`/api/documents/by-opening/${opening.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe("Doc B");
  });

  it("can delete a property-attached document", async () => {
    const org = await signupTestOrg();
    const { propertyId } = await createPortfolioHierarchy(org.token);
    const created = await request(app).post("/api/documents").set("Authorization", `Bearer ${org.token}`)
      .send({ property_id: propertyId, document_type: "other", title: "To Delete", storage_url: "https://example.com/c.pdf" });

    const del = await request(app).delete(`/api/documents/${created.body.id}`).set("Authorization", `Bearer ${org.token}`);
    expect(del.status).toBe(204);

    const list = await request(app).get(`/api/documents/by-property/${propertyId}`).set("Authorization", `Bearer ${org.token}`);
    expect(list.body.length).toBe(0);
  });

  it("rejects a property belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { propertyId } = await createPortfolioHierarchy(orgA.token);

    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ property_id: propertyId, document_type: "other", title: "Should be blocked", storage_url: "https://example.com/x.pdf" });

    expect(res.status).toBe(403);
  });

  it("rejects an opening belonging to another org, even guessed correctly", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .get(`/api/documents/by-opening/${opening.id}`)
      .set("Authorization", `Bearer ${orgB.token}`);

    expect(res.status).toBe(403);
  });

  it("a technician can upload a document (field work)", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const email = `doc-tech-${Date.now()}@example.com`;
    const password = "password12345";
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`)
      .send({ email, password, full_name: "Tech", role: "technician" });
    const login = await request(app).post("/api/auth/login").send({ email, password });

    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ opening_id: opening.id, document_type: "warranty", title: "Field-uploaded warranty", storage_url: "https://example.com/w.pdf" });

    expect(res.status).toBe(201);
  });

  it("a viewer cannot upload a document", async () => {
    const org = await signupTestOrg();
    const { propertyId } = await createPortfolioHierarchy(org.token);
    const email = `doc-viewer-${Date.now()}@example.com`;
    const password = "password12345";
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`)
      .send({ email, password, full_name: "Viewer", role: "viewer" });
    const login = await request(app).post("/api/auth/login").send({ email, password });

    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ property_id: propertyId, document_type: "other", title: "Should be blocked", storage_url: "https://example.com/x.pdf" });

    expect(res.status).toBe(403);
  });
});
