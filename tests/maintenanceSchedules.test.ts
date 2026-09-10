import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

describe("recurring maintenance schedules", () => {
  it("an admin can create a schedule", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const res = await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({ opening_id: opening.id, title: "Quarterly closer check", interval_unit: "months", interval_count: 3 });

    expect(res.status).toBe(201);
    expect(res.body.is_active).toBe(true);
  });

  it("a technician cannot create a schedule", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const email = `sched-tech-${Date.now()}@example.com`;
    await request(app).post("/api/auth/register").set("Authorization", `Bearer ${org.token}`)
      .send({ email, password: "password12345", full_name: "Tech", role: "technician" });
    const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });

    const res = await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ opening_id: opening.id, title: "Should be blocked", interval_unit: "months", interval_count: 1 });

    expect(res.status).toBe(403);
  });

  it("a schedule due in the past generates a work order when the list is loaded (lazy generation)", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "Overdue maintenance", interval_unit: "months", interval_count: 1,
        start_date: daysAgo(10),
      });

    const list = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    expect(list.body.some((w: any) => w.title === "Overdue maintenance")).toBe(true);
  });

  it("a schedule due in the future does NOT generate anything yet", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "Future maintenance", interval_unit: "months", interval_count: 1,
        start_date: daysFromNow(30),
      });

    const list = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    expect(list.body.some((w: any) => w.title === "Future maintenance")).toBe(false);
  });

  it("a paused (inactive) schedule does NOT generate even if due", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const created = await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "Paused overdue maintenance", interval_unit: "months", interval_count: 1,
        start_date: daysAgo(10),
      });
    await request(app).patch(`/api/maintenance-schedules/${created.body.id}`).set("Authorization", `Bearer ${org.token}`)
      .send({ is_active: false });

    const list = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    expect(list.body.some((w: any) => w.title === "Paused overdue maintenance")).toBe(false);
  });

  it("generates exactly ONE work order even when far overdue, not one per missed interval", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "Weekly check way overdue", interval_unit: "days", interval_count: 7,
        start_date: daysAgo(100),
      });

    const list = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    const matches = list.body.filter((w: any) => w.title === "Weekly check way overdue");
    expect(matches.length).toBe(1);
  });

  it("next_due_date lands in the future after generating, so listing twice doesn't duplicate", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "No duplicate check", interval_unit: "days", interval_count: 30,
        start_date: daysAgo(5),
      });

    await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    const secondList = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    const matches = secondList.body.filter((w: any) => w.title === "No duplicate check");
    expect(matches.length).toBe(1);

    const schedules = await request(app).get("/api/maintenance-schedules").set("Authorization", `Bearer ${org.token}`);
    const schedule = schedules.body.find((s: any) => s.title === "No duplicate check");
    expect(new Date(schedule.next_due_date).getTime()).toBeGreaterThan(Date.now());
  });

  it("a generated work order correctly traces back to its schedule", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    const schedule = await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "Traceable maintenance", interval_unit: "months", interval_count: 1,
        start_date: daysAgo(1),
      });

    const list = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    const wo = list.body.find((w: any) => w.title === "Traceable maintenance");
    expect(wo.generated_from_schedule_id).toBe(schedule.body.id);
  });

  it("the dedicated generate-due endpoint does the same thing as the lazy check", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "Manual trigger test", interval_unit: "months", interval_count: 1,
        start_date: daysAgo(1),
      });

    const res = await request(app).post("/api/maintenance-schedules/generate-due").set("Authorization", `Bearer ${org.token}`);
    expect(res.status).toBe(200);
    expect(res.body.generated).toBeGreaterThanOrEqual(1);
  });

  it("rejects an opening belonging to another org", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId);

    const res = await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${orgB.token}`)
      .send({ opening_id: opening.id, title: "Should be blocked", interval_unit: "months", interval_count: 1 });

    expect(res.status).toBe(403);
  });

  it("never generates or shows another org's scheduled work", async () => {
    const orgA = await signupTestOrg("Org A");
    const orgB = await signupTestOrg("Org B");
    const { buildingId } = await createPortfolioHierarchy(orgA.token);
    const opening = await createTestOpening(orgA.token, buildingId, { opening_code: "ORG-A-SCHED-ONLY" });

    await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${orgA.token}`)
      .send({ opening_id: opening.id, title: "Org A only", interval_unit: "months", interval_count: 1, start_date: daysAgo(1) });

    const orgBWorkOrders = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${orgB.token}`);
    expect(orgBWorkOrders.body.some((w: any) => w.title === "Org A only")).toBe(false);
  });

  // Regression test for a real, reproducible bug found during manual
  // verification (not theoretical): firing several genuinely concurrent
  // requests at a due schedule produced multiple duplicate work orders
  // from the same schedule, because nothing prevented two overlapping
  // calls from both reading the "this is due" state before either had
  // committed its advance. Fixed with SELECT ... FOR UPDATE SKIP LOCKED
  // inside a transaction. The 11 tests above never caught this because
  // they only ever call the endpoint sequentially, one await at a time —
  // this test exists specifically because that gap existed.
  it("concurrent overlapping requests generate exactly one work order, not one per request", async () => {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);

    await request(app)
      .post("/api/maintenance-schedules")
      .set("Authorization", `Bearer ${org.token}`)
      .send({
        opening_id: opening.id, title: "Concurrency regression check", interval_unit: "months", interval_count: 1,
        start_date: daysAgo(1),
      });

    // Fire 5 genuinely overlapping requests — Promise.all, not sequential awaits.
    await Promise.all([
      request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`),
      request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`),
      request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`),
      request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`),
      request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`),
    ]);

    const finalList = await request(app).get("/api/work-orders").set("Authorization", `Bearer ${org.token}`);
    const matches = finalList.body.filter((w: any) => w.title === "Concurrency regression check");
    expect(matches.length).toBe(1);
  });
});
