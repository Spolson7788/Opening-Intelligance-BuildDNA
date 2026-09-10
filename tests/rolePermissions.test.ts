import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";

async function inviteAndLogin(adminToken: string, role: string) {
  const email = `role-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "password12345";
  await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, password, full_name: `Test ${role}`, role });
  const login = await request(app).post("/api/auth/login").send({ email, password });
  return login.body.token as string;
}

describe("role-based permissions", () => {
  describe("viewer — read-only, full stop", () => {
    it("can read openings", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      await createTestOpening(org.token, buildingId);
      const viewerToken = await inviteAndLogin(org.token, "viewer");

      const res = await request(app).get("/api/openings").set("Authorization", `Bearer ${viewerToken}`);
      expect(res.status).toBe(200);
    });

    it("cannot log a service event", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const opening = await createTestOpening(org.token, buildingId);
      const viewerToken = await inviteAndLogin(org.token, "viewer");

      const res = await request(app)
        .post("/api/events/service-events")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ opening_id: opening.id, event_date: "2026-01-01", work_performed: "Should be blocked" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("read_only_role");
    });

    it("cannot create a property", async () => {
      const org = await signupTestOrg();
      const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${org.token}`);
      const viewerToken = await inviteAndLogin(org.token, "viewer");

      const res = await request(app)
        .post("/api/portfolio/properties")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ portfolio_id: portfolios.body[0].id, name: "Should Not Get Created" });

      expect(res.status).toBe(403);
    });
  });

  describe("technician — real field work only", () => {
    it("can log a service event", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const opening = await createTestOpening(org.token, buildingId);
      const techToken = await inviteAndLogin(org.token, "technician");

      const res = await request(app)
        .post("/api/events/service-events")
        .set("Authorization", `Bearer ${techToken}`)
        .send({ opening_id: opening.id, event_date: "2026-01-01", work_performed: "Tightened hinges" });

      expect(res.status).toBe(201);
    });

    it("can add hardware", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const opening = await createTestOpening(org.token, buildingId);
      const techToken = await inviteAndLogin(org.token, "technician");

      const res = await request(app)
        .post("/api/hardware")
        .set("Authorization", `Bearer ${techToken}`)
        .send({ opening_id: opening.id, component_type: "lockset" });

      expect(res.status).toBe(201);
    });

    it("can edit and delete hardware they can see", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const opening = await createTestOpening(org.token, buildingId);
      const created = await request(app).post("/api/hardware").set("Authorization", `Bearer ${org.token}`)
        .send({ opening_id: opening.id, component_type: "closer" });
      const techToken = await inviteAndLogin(org.token, "technician");

      const edit = await request(app)
        .patch(`/api/hardware/${created.body.id}`)
        .set("Authorization", `Bearer ${techToken}`)
        .send({ manufacturer: "Updated By Tech" });
      expect(edit.status).toBe(200);

      const del = await request(app)
        .delete(`/api/hardware/${created.body.id}`)
        .set("Authorization", `Bearer ${techToken}`);
      expect(del.status).toBe(204);
    });

    it("can trigger a health score recompute", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const opening = await createTestOpening(org.token, buildingId);
      const techToken = await inviteAndLogin(org.token, "technician");

      const res = await request(app)
        .post(`/api/openings/${opening.id}/recompute-health-score`)
        .set("Authorization", `Bearer ${techToken}`);
      expect(res.status).toBe(200);
    });

    it("CANNOT create a new opening", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const techToken = await inviteAndLogin(org.token, "technician");

      const res = await request(app)
        .post("/api/openings")
        .set("Authorization", `Bearer ${techToken}`)
        .send({ opening_code: "TECH-SHOULD-NOT-CREATE", building_id: buildingId, opening_type: "door" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("insufficient_role_for_action");
    });

    it("CANNOT bulk-import openings", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const techToken = await inviteAndLogin(org.token, "technician");

      const res = await request(app)
        .post("/api/openings/bulk-import")
        .set("Authorization", `Bearer ${techToken}`)
        .send({ building_id: buildingId, rows: [{ opening_code: "TECH-BULK-001", opening_type: "door" }] });

      expect(res.status).toBe(403);
    });

    it("CANNOT create a property", async () => {
      const org = await signupTestOrg();
      const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${org.token}`);
      const techToken = await inviteAndLogin(org.token, "technician");

      const res = await request(app)
        .post("/api/portfolio/properties")
        .set("Authorization", `Bearer ${techToken}`)
        .send({ portfolio_id: portfolios.body[0].id, name: "Tech Should Not Create This" });

      expect(res.status).toBe(403);
    });

    it("can still read everything, same as any role", async () => {
      const org = await signupTestOrg();
      const { propertyId } = await createPortfolioHierarchy(org.token);
      const techToken = await inviteAndLogin(org.token, "technician");

      const res = await request(app)
        .get(`/api/portfolio/capital-forecast?property_id=${propertyId}`)
        .set("Authorization", `Bearer ${techToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe("inspector — same field-write scope as technician, by design", () => {
    it("can log an inspection event", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const opening = await createTestOpening(org.token, buildingId, { fire_rated: true });
      const inspectorToken = await inviteAndLogin(org.token, "inspector");

      const res = await request(app)
        .post("/api/events/inspection-events")
        .set("Authorization", `Bearer ${inspectorToken}`)
        .send({ opening_id: opening.id, event_date: "2026-01-01", inspection_type: "fire_door_nfpa80", passed: true });

      expect(res.status).toBe(201);
    });

    it("CANNOT create a new opening, same restriction as technician", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const inspectorToken = await inviteAndLogin(org.token, "inspector");

      const res = await request(app)
        .post("/api/openings")
        .set("Authorization", `Bearer ${inspectorToken}`)
        .send({ opening_code: "INSPECTOR-SHOULD-NOT-CREATE", building_id: buildingId, opening_type: "door" });

      expect(res.status).toBe(403);
    });
  });

  describe("facilities_manager — full access except team management", () => {
    it("CAN create a property (unlike technician/viewer)", async () => {
      const org = await signupTestOrg();
      const portfolios = await request(app).get("/api/portfolio/portfolios").set("Authorization", `Bearer ${org.token}`);
      const fmToken = await inviteAndLogin(org.token, "facilities_manager");

      const res = await request(app)
        .post("/api/portfolio/properties")
        .set("Authorization", `Bearer ${fmToken}`)
        .send({ portfolio_id: portfolios.body[0].id, name: "FM Created This Fine" });

      expect(res.status).toBe(201);
    });

    it("CAN bulk-import openings", async () => {
      const org = await signupTestOrg();
      const { buildingId } = await createPortfolioHierarchy(org.token);
      const fmToken = await inviteAndLogin(org.token, "facilities_manager");

      const res = await request(app)
        .post("/api/openings/bulk-import")
        .set("Authorization", `Bearer ${fmToken}`)
        .send({ building_id: buildingId, rows: [{ opening_code: "FM-BULK-001", opening_type: "door" }] });

      expect(res.status).toBe(207);
    });

    it("still CANNOT invite a new team member (team management stays admin-only)", async () => {
      const org = await signupTestOrg();
      const fmToken = await inviteAndLogin(org.token, "facilities_manager");

      const res = await request(app)
        .post("/api/auth/register")
        .set("Authorization", `Bearer ${fmToken}`)
        .send({ email: "fm-invited@example.com", password: "password12345", full_name: "X", role: "viewer" });

      expect(res.status).toBe(403);
    });
  });
});
