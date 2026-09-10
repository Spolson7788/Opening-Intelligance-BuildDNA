import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

async function inviteAndLogin(adminToken: string, role: string) {
  const email = `wo-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "password12345";
  const invite = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, password, full_name: `Test ${role}`, role });
  const login = await request(app).post("/api/auth/login").send({ email, password });
  return { token: login.body.token as string, userId: invite.body.id as string };
}

describe("work orders", () => {
  it("an admin can create a work order", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Replace worn closer", priority: "high" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.opening_code).toBe(opening.opening_code);
  });

  it("a technician cannot create a work order", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const tech = await inviteAndLogin(org.token, "technician");

    const res = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ opening_id: opening.id, title: "Should be blocked" });

    expect(res.status).toBe(403);
  });

  it("can assign a work order to a real team member", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const tech = await inviteAndLogin(org.token, "technician");

    const res = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Fix door", assigned_to_user_id: tech.userId });

    expect(res.status).toBe(201);
    expect(res.body.assigned_to_user_id).toBe(tech.userId);
    expect(res.body.assigned_to_name).toBeTruthy();
  });

  it("rejects assigning to a user outside the org", async () => {
    const org = await signupTestOrg();
    const otherOrg = await signupTestOrg("Other Org");
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const outsider = await inviteAndLogin(otherOrg.token, "technician");

    const res = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Should fail", assigned_to_user_id: outsider.userId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_assignee");
  });

  it("the assigned technician CAN update their own work order's status", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const tech = await inviteAndLogin(org.token, "technician");
    const created = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "My task", assigned_to_user_id: tech.userId });

    const res = await request(app)
      .post(`/api/work-orders/${created.body.id}/status`)
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("a technician CANNOT update the status of someone else's work order", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const techA = await inviteAndLogin(org.token, "technician");
    const techB = await inviteAndLogin(org.token, "technician");
    const created = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Assigned to A", assigned_to_user_id: techA.userId });

    const res = await request(app)
      .post(`/api/work-orders/${created.body.id}/status`)
      .set("Authorization", `Bearer ${techB.token}`)
      .send({ status: "done" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_assigned_to_you");
  });

  it("a technician cannot use the full PATCH route even for their own work order", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const tech = await inviteAndLogin(org.token, "technician");
    const created = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Task", assigned_to_user_id: tech.userId });

    const res = await request(app)
      .patch(`/api/work-orders/${created.body.id}`)
      .set("Authorization", `Bearer ${tech.token}`)
      .send({ priority: "urgent" });

    expect(res.status).toBe(403);
  });

  it("setting status to done stamps completed_at; moving off done clears it", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const created = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Task" });

    const done = await request(app).patch(`/api/work-orders/${created.body.id}`).set("Authorization", `Bearer ${org.token}`)
      .send({ status: "done" });
    expect(done.body.completed_at).toBeTruthy();

    const reopened = await request(app).patch(`/api/work-orders/${created.body.id}`).set("Authorization", `Bearer ${org.token}`)
      .send({ status: "open" });
    expect(reopened.body.completed_at).toBeNull();
  });

  it("open/urgent work orders sort ahead of done/low-priority ones", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const openingA = await createTestOpening(org.token, buildingId, { opening_code: "WO-SORT-A" });
    const openingB = await createTestOpening(org.token, buildingId, { opening_code: "WO-SORT-B" });

    const low = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: openingA.id, title: "Low priority open task", priority: "low" });
    const urgent = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: openingB.id, title: "Urgent open task", priority: "urgent" });
    await request(app).patch(`/api/work-orders/${low.body.id}`).set("Authorization", `Bearer ${org.token}`).send({ status: "done" });

    const res = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    const ids = res.body.map((w: any) => w.id);
    expect(ids.indexOf(urgent.body.id)).toBeLessThan(ids.indexOf(low.body.id));
  });

  it("filters by status", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const wo = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Task" });
    await request(app).patch(`/api/work-orders/${wo.body.id}`).set("Authorization", `Bearer ${org.token}`).send({ status: "done" });

    const res = await request(app).get("/api/work-orders?status=done").set("Authorization", `Bearer ${org.token}`);
    expect(res.body.every((w: any) => w.status === "done")).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects an opening belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .post("/api/work-orders")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ opening_id: opening.id, title: "Should be blocked" });

    expect(res.status).toBe(403);
  });

  it("never shows another org's work orders", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId, { opening_code: "ORG-A-WO-ONLY" });
    await request(app).post("/api/work-orders").set("Authorization", `Bearer ${orgA.token}`)
      .send({ opening_id: opening.id, title: "Org A task" });

    const res = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${orgB.token}`);
    expect(res.body.some((w: any) => w.opening_code === "ORG-A-WO-ONLY")).toBe(false);
  });

  it("a viewer can still read the work order list", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    await request(app).post("/api/work-orders").set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Task" });
    const viewer = await inviteAndLogin(org.token, "viewer");

    const res = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${viewer.token}`);
    expect(res.status).toBe(200);
  });
});
