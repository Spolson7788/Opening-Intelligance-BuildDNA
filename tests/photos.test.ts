import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

describe("photos & video", () => {
  it("presign accepts a valid image content type", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/photos/presign")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, content_type: "image/jpeg" });

    expect([200, 503]).toContain(res.status);
    if (res.status === 400) throw new Error("image/jpeg should never be rejected as unsupported");
  });

  it("presign accepts a valid video content type", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/photos/presign")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, content_type: "video/mp4" });

    expect(res.status).not.toBe(400);
  });

  it("presign rejects an unsupported content type", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/photos/presign")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, content_type: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_content_type");
  });

  it("confirming with an image content_type records media_type = photo", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/photos")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        storage_url: "https://example-bucket.s3.amazonaws.com/org/opening/test.jpg",
        content_type: "image/jpeg",
      });

    expect(res.status).toBe(201);
    expect(res.body.media_type).toBe("photo");
  });

  it("confirming with a video content_type records media_type = video", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/photos")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        storage_url: "https://example-bucket.s3.amazonaws.com/org/opening/test.mp4",
        content_type: "video/mp4",
      });

    expect(res.status).toBe(201);
    expect(res.body.media_type).toBe("video");
  });

  it("a client can't force media_type directly — only content_type controls it", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/photos")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id,
        storage_url: "https://example-bucket.s3.amazonaws.com/org/opening/test.jpg",
        content_type: "image/jpeg",
        media_type: "video",
      });

    expect(res.status).toBe(201);
    expect(res.body.media_type).toBe("photo");
  });

  it("lists both photos and videos together for an opening", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    await request(app).post("/api/photos").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, storage_url: "https://x.s3.amazonaws.com/a.jpg", content_type: "image/jpeg",
    });
    await request(app).post("/api/photos").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, storage_url: "https://x.s3.amazonaws.com/b.mp4", content_type: "video/mp4",
    });

    const res = await request(app)
      .get(`/api/photos/by-opening/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);

    expect(res.body.length).toBe(2);
    const types = res.body.map((p: any) => p.media_type).sort();
    expect(types).toEqual(["photo", "video"]);
  });

  it("rejects presign for an opening belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .post("/api/photos/presign")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ opening_id: opening.id, content_type: "image/jpeg" });

    expect(res.status).toBe(403);
  });

  it("deletes a photo record", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const created = await request(app).post("/api/photos").set("Authorization", `Bearer ${org.token}`).send({
      opening_id: opening.id, storage_url: "https://x.s3.amazonaws.com/c.jpg", content_type: "image/jpeg",
    });

    const del = await request(app)
      .delete(`/api/photos/${created.body.id}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(del.status).toBe(204);

    const list = await request(app)
      .get(`/api/photos/by-opening/${opening.id}`)
      .set("Authorization", `Bearer ${org.token}`);
    expect(list.body.find((p: any) => p.id === created.body.id)).toBeUndefined();
  });
});
