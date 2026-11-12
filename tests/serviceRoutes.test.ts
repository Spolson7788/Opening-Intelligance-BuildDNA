import { describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { app } from "./helpers";
import { pool } from "../src/db/pool";
import { straightLinePlan } from "../src/services/driveTime";
import { COMPANY_DASHBOARD_REFUSAL } from "../src/services/companyDashboard";

async function signup(orgType: "customer" | "service_partner") {
  const stamp = `${orgType}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = await request(app).post("/api/auth/signup").send({
    organization_name: `Synthetic ${stamp}`, org_type: orgType, email: `${stamp}@example.invalid`, password: "password12345", full_name: "Synthetic",
  });
  expect(created.status).toBe(201);
  return { token: created.body.token as string, organizationId: created.body.organizationId as string, stamp };
}

async function addTech(adminToken: string, stamp: string, name: string) {
  const email = `${name}-${stamp}@example.invalid`;
  const created = await request(app).post("/api/auth/register").set("Authorization", `Bearer ${adminToken}`).send({
    email, password: "password12345", full_name: name, role: "technician",
  });
  expect(created.status).toBe(201);
  const login = await request(app).post("/api/auth/login").send({ email, password: "password12345" });
  expect(login.status).toBe(200);
  return { token: login.body.token as string, id: created.body.id as string };
}

async function site(token: string, name: string, latitude: number, longitude: number) {
  const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${token}`);
  expect(portfolios.status).toBe(200);
  const property = await request(app).post("/api/portfolio/properties").set("Authorization", `Bearer ${token}`).send({
    portfolio_id: portfolios.body[0].id, name, property_type: "other", address_line1: `${name} Street`, city: "Phoenix", state: "AZ", latitude, longitude,
  });
  expect(property.status).toBe(201);
  const building = await request(app).post("/api/portfolio/buildings").set("Authorization", `Bearer ${token}`).send({ property_id: property.body.id, name: "Main" });
  expect(building.status).toBe(201);
  const opening = await request(app).post("/api/openings").set("Authorization", `Bearer ${token}`).send({
    opening_code: `${name}-${Math.random().toString(36).slice(2, 7)}`, building_id: building.body.id, opening_type: "door",
  });
  expect(opening.status).toBe(201);
  return { propertyId: property.body.id as string, openingId: opening.body.id as string };
}

async function workOrder(token: string, openingId: string, title: string) {
  const created = await request(app).post("/api/work-orders").set("Authorization", `Bearer ${token}`).send({ opening_id: openingId, title, priority: "normal" });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe("today's route and nearby work", () => {
  it("orders by the straight-line estimate, keeps techs out of the dashboard, and requires a manager for pickup", async () => {
    const previousKey = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    try {
      const provider = await signup("service_partner");
      const customer = await signup("customer");
      const techA = await addTech(provider.token, provider.stamp, "tech-a");
      const techB = await addTech(provider.token, provider.stamp, "tech-b");
      const admin = await pool.query("SELECT id FROM users WHERE organization_id = $1 AND role = 'admin' LIMIT 1", [provider.organizationId]);
      const serviceDate = (await pool.query("SELECT CURRENT_DATE::text AS day")).rows[0].day as string;
      const west = await site(provider.token, "West yard", 33.45, -112.07);
      const near = await site(provider.token, "Near shop", 33.5, -112.07);
      const far = await site(provider.token, "Far plant", 33.8, -112.07);
      const noticeSite = await site(customer.token, "Notice clinic", 33.52, -112.07);
      const grant = await request(app).put(`/api/provider-assignments/${noticeSite.propertyId}/${provider.organizationId}`).set("Authorization", `Bearer ${customer.token}`).send({ active: true });
      expect(grant.status).toBe(200);
      await pool.query(
        `UPDATE provider_accounts pa SET notice_required = true
         FROM provider_account_sites pas
         WHERE pas.account_id = pa.id AND pas.property_id = $1 AND pa.provider_organization_id = $2`,
        [noticeSite.propertyId, provider.organizationId],
      );

      const westWork = await workOrder(provider.token, west.openingId, "Closer repair");
      const westOther = await workOrder(provider.token, west.openingId, "Second tech stop");
      const adminWork = await workOrder(provider.token, west.openingId, "Admin check");
      const nearWork = await workOrder(provider.token, near.openingId, "Nearby pickup");
      const nearExtra = await workOrder(provider.token, near.openingId, "Second pickup");
      const farWork = await workOrder(provider.token, far.openingId, "Far repair");
      const noticeWork = await workOrder(customer.token, noticeSite.openingId, "Notice repair");
      const inspection = await request(app).post("/api/maintenance-schedules").set("Authorization", `Bearer ${provider.token}`).send({
        opening_id: west.openingId, title: "Due inspection", priority: "normal", interval_unit: "months", interval_count: 1, start_date: serviceDate,
      });
      expect(inspection.status).toBe(201);
      for (const workId of [nearWork, nearExtra, farWork, noticeWork]) {
        await pool.query(
          "INSERT INTO work_pickup_eligibility (id, provider_organization_id, work_kind, work_id, eligible) VALUES (gen_random_uuid(), $1, 'work_order', $2, true)",
          [provider.organizationId, workId],
        );
      }

      const denied = await request(app).get(`/api/company-dashboard/routes?date=${serviceDate}`).set("Authorization", `Bearer ${techA.token}`);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: "company_dashboard_forbidden", message: COMPANY_DASHBOARD_REFUSAL });
      expect(denied.body.routes).toBeUndefined();

      const people = await request(app).get("/api/company-dashboard/routes/assignees").set("Authorization", `Bearer ${provider.token}`);
      expect(people.status).toBe(200);
      expect(people.body.people.map((person: { id: string }) => person.id)).toEqual(expect.arrayContaining([admin.rows[0].id, techA.id, techB.id]));

      const built = await request(app).post("/api/company-dashboard/routes").set("Authorization", `Bearer ${provider.token}`).send({
        service_date: serviceDate,
        assigned_user_id: techA.id,
        stops: [
          { work_kind: "work_order", work_id: westWork, time_window: "8:00–10:00" },
          { work_kind: "inspection", work_id: inspection.body.id },
          { work_kind: "work_order", work_id: farWork, time_window: "1:00–3:00" },
        ],
      });
      expect(built.status).toBe(201);
      expect(built.body.drive_source).toBe("straight_line");
      expect(built.body.drive_label).toMatch(/Straight-line estimate/);
      expect(JSON.stringify(built.body)).not.toMatch(/AIza|GOOGLE_MAPS_API_KEY=/);
      const expected = straightLinePlan([
        { id: westWork, latitude: 33.45, longitude: -112.07 },
        { id: inspection.body.id, latitude: 33.45, longitude: -112.07 },
        { id: farWork, latitude: 33.8, longitude: -112.07 },
      ]);
      const approved = built.body.route.stops.filter((stop: { status: string }) => stop.status === "approved");
      expect(approved.map((stop: { work_id: string }) => stop.work_id)).toEqual(expected.order);
      expect(approved[0].drive_minutes).toBeNull();
      expect(approved[0].time_window).toBe("8:00–10:00");
      expect(approved[2].drive_minutes).toBeGreaterThan(approved[1].drive_minutes);
      expect(built.body.total_minutes).toBe(expected.total_minutes);
      const savedRoutes = await request(app).get(`/api/company-dashboard/routes?date=${serviceDate}`).set("Authorization", `Bearer ${provider.token}`);
      expect(savedRoutes.body.drive_label).toMatch(/Straight-line estimate/);

      const second = await request(app).post("/api/company-dashboard/routes").set("Authorization", `Bearer ${provider.token}`).send({
        service_date: serviceDate, assigned_user_id: techB.id, stops: [{ work_kind: "work_order", work_id: westOther }],
      });
      expect(second.status).toBe(201);
      const claimedByRoute = await request(app).post("/api/company-dashboard/routes").set("Authorization", `Bearer ${provider.token}`).send({
        service_date: serviceDate, assigned_user_id: admin.rows[0].id, stops: [{ work_kind: "work_order", work_id: westWork }],
      });
      expect(claimedByRoute.status).toBe(409);
      const adminRoute = await request(app).post("/api/company-dashboard/routes").set("Authorization", `Bearer ${provider.token}`).send({
        service_date: serviceDate, assigned_user_id: admin.rows[0].id, stops: [{ work_kind: "work_order", work_id: adminWork }],
      });
      expect(adminRoute.status).toBe(201);
      const adminField = await request(app).get(`/api/field-routes/today?date=${serviceDate}`).set("Authorization", `Bearer ${provider.token}`);
      expect(adminField.body.route.stops.map((stop: { work_id: string }) => stop.work_id)).toEqual([adminWork]);

      const own = await request(app).get(`/api/field-routes/today?date=${serviceDate}`).set("Authorization", `Bearer ${techA.token}`);
      expect(own.status).toBe(200);
      expect(own.body.route.stops.map((stop: { work_id: string }) => stop.work_id)).toEqual(expected.order);
      const other = await request(app).get(`/api/field-routes/today?date=${serviceDate}`).set("Authorization", `Bearer ${techB.token}`);
      expect(other.body.route.stops.map((stop: { work_id: string }) => stop.work_id)).toEqual([westOther]);
      expect(other.body.route.stops.some((stop: { work_id: string }) => stop.work_id === westWork)).toBe(false);

      const nearby = await request(app).get("/api/field-routes/nearby").set("Authorization", `Bearer ${techA.token}`);
      expect(nearby.status).toBe(200);
      const listed = nearby.body.nearby.map((row: { work_id: string }) => row.work_id);
      expect(listed).toContain(nearWork);
      expect(listed).toContain(noticeWork);
      expect(listed).not.toContain(farWork);
      expect(nearby.body.nearby.find((row: { work_id: string }) => row.work_id === noticeWork).schedule_only).toBe(true);
      expect(nearby.body.nearby.find((row: { work_id: string }) => row.work_id === nearWork).schedule_only).toBe(false);

      const blocked = await request(app).post("/api/field-routes/nearby").set("Authorization", `Bearer ${techA.token}`).send({ work_kind: "work_order", work_id: noticeWork });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe("schedule_only");
      const tooFar = await request(app).post("/api/field-routes/nearby").set("Authorization", `Bearer ${techA.token}`).send({ work_kind: "work_order", work_id: farWork });
      expect(tooFar.status).toBe(403);
      const requested = await request(app).post("/api/field-routes/nearby").set("Authorization", `Bearer ${techA.token}`).send({ work_kind: "work_order", work_id: nearWork });
      expect(requested.status).toBe(201);
      expect(requested.body.status).toBe("requested");
      const stillWaiting = await request(app).get(`/api/field-routes/today?date=${serviceDate}`).set("Authorization", `Bearer ${techA.token}`);
      expect(stillWaiting.body.route.stops.some((stop: { work_id: string }) => stop.work_id === nearWork)).toBe(false);
      const claimed = await request(app).post("/api/field-routes/nearby").set("Authorization", `Bearer ${techB.token}`).send({ work_kind: "work_order", work_id: nearWork });
      expect(claimed.status).toBe(409);
      expect(claimed.body.error).toBe("work_already_claimed");

      const managerView = await request(app).get(`/api/company-dashboard/routes?date=${serviceDate}`).set("Authorization", `Bearer ${provider.token}`);
      const pending = managerView.body.routes.flatMap((route: { stops: Array<{ id: string; work_id: string; status: string }> }) => route.stops).find((stop: { work_id: string; status: string }) => stop.work_id === nearWork && stop.status === "requested");
      const approvedStop = await request(app).post(`/api/company-dashboard/routes/stops/${pending.id}/decision`).set("Authorization", `Bearer ${provider.token}`).send({ decision: "approve" });
      expect(approvedStop.status).toBe(200);
      const visible = await request(app).get(`/api/field-routes/today?date=${serviceDate}`).set("Authorization", `Bearer ${techA.token}`);
      expect(visible.body.route.stops.some((stop: { work_id: string; status: string }) => stop.work_id === nearWork && stop.status === "approved")).toBe(true);
      const techDecision = await request(app).post(`/api/company-dashboard/routes/stops/${pending.id}/decision`).set("Authorization", `Bearer ${techA.token}`).send({ decision: "decline" });
      expect(techDecision.status).toBe(403);

      const extra = await request(app).post("/api/field-routes/nearby").set("Authorization", `Bearer ${techA.token}`).send({ work_kind: "work_order", work_id: nearExtra });
      expect(extra.status).toBe(201);
      const extraPending = (await request(app).get(`/api/company-dashboard/routes?date=${serviceDate}`).set("Authorization", `Bearer ${provider.token}`)).body.routes
        .flatMap((route: { stops: Array<{ id: string; work_id: string; status: string }> }) => route.stops)
        .find((stop: { work_id: string; status: string }) => stop.work_id === nearExtra && stop.status === "requested");
      const declined = await request(app).post(`/api/company-dashboard/routes/stops/${extraPending.id}/decision`).set("Authorization", `Bearer ${provider.token}`).send({ decision: "decline" });
      expect(declined.status).toBe(200);
      const freed = await request(app).post("/api/field-routes/nearby").set("Authorization", `Bearer ${techB.token}`).send({ work_kind: "work_order", work_id: nearExtra });
      expect(freed.status).toBe(201);

      const inspectionStop = visible.body.route.stops.find((stop: { work_id: string }) => stop.work_id === inspection.body.id);
      const marked = await request(app).post(`/api/field-routes/stops/${inspectionStop.id}/done`).set("Authorization", `Bearer ${techA.token}`);
      expect(marked.status).toBe(200);
      const due = await pool.query("SELECT next_due_date::text AS day FROM maintenance_schedules WHERE id = $1", [inspection.body.id]);
      expect(due.rows[0].day > serviceDate).toBe(true);
      const workStop = visible.body.route.stops.find((stop: { work_id: string }) => stop.work_id === westWork);
      expect((await request(app).post(`/api/field-routes/stops/${workStop.id}/done`).set("Authorization", `Bearer ${techB.token}`)).status).toBe(404);
      expect((await request(app).post(`/api/field-routes/stops/${workStop.id}/done`).set("Authorization", `Bearer ${techA.token}`)).status).toBe(200);
      const done = await pool.query("SELECT status FROM work_orders WHERE id = $1", [westWork]);
      expect(done.rows[0].status).toBe("done");
    } finally {
      if (previousKey) process.env.GOOGLE_MAPS_API_KEY = previousKey;
    }
  });

  it("keeps a phone-sized back control and the field route in the app", () => {
    expect(readFileSync("dashboard/src/pages/CompanyCustomerPage.tsx", "utf8")).toContain("Back to customers");
    expect(readFileSync("dashboard/src/pages/CompanySitePage.tsx", "utf8")).toContain("BackLink");
    expect(readFileSync("dashboard/src/pages/CompanyOpeningPage.tsx", "utf8")).toContain("Back to");
    expect(readFileSync("dashboard/src/company.css", "utf8")).toContain("min-height: 48px");
    expect(readFileSync("field-app/src/pages/TodayRoutePage.tsx", "utf8")).toContain("Open in Maps");
    expect(readFileSync("field-app/src/pages/TodayRoutePage.tsx", "utf8")).toContain("Schedule only");
    expect(readFileSync("field-app/src/pages/ScanPage.tsx", "utf8")).toContain("Today's route");
    expect(readFileSync("src/routes/serviceRoutes.ts", "utf8")).toContain("GOOGLE_MAPS_API_KEY");
  });
});
