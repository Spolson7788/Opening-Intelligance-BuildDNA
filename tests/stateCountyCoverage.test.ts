import { it, expect } from "vitest";
import request from "supertest";
import { app, signupTestOrg, createPortfolioHierarchy } from "./helpers";

const MARICOPA = "04013";
const HARRIS = "48201";

async function addTech(token: string) {
  const email = `tech-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const created = await request(app).post("/api/members").set("Authorization", `Bearer ${token}`).send({
    email, full_name: "Terry Tech", role: "technician", temporary_password: "testpassword123", is_test_account: true,
  });
  if (created.status !== 201) throw new Error(`member ${created.status} ${JSON.stringify(created.body)}`);
  const login = await request(app).post("/api/auth/login").send({ email, password: "testpassword123" });
  return { token: login.body.token as string, userId: created.body.id as string };
}

it("limits a technician to their county and refuses an out-of-area assignment", async () => {
  const states = await request(app).get("/api/geo/states").set("Authorization", `Bearer ${(await signupTestOrg()).token}`);
  expect(states.status).toBe(200);
  expect(states.body).toHaveLength(51);

  const customer = await signupTestOrg("Customer");
  const provider = await signupTestOrg("Provider");
  const phoenix = await createPortfolioHierarchy(customer.token);
  const houston = await createPortfolioHierarchy(customer.token);
  const set = (propertyId: string, state: string, county: string) => request(app)
    .patch(`/api/geo/facilities/${propertyId}`)
    .set("Authorization", `Bearer ${customer.token}`)
    .send({ state_code: state, county_fips: county });
  expect((await set(phoenix.propertyId, "AZ", MARICOPA)).status).toBe(200);
  expect((await set(houston.propertyId, "TX", HARRIS)).status).toBe(200);

  const branchId = crypto.randomUUID();
  const branch = await request(app).put(`/api/branches/${branchId}`).set("Authorization", `Bearer ${provider.token}`).send({
    name: "Phoenix", default_state: "AZ", default_territory: null, is_active: true,
  });
  expect(branch.status).toBe(200);
  expect((await request(app).post(`/api/geo/branches/${branchId}/areas`).set("Authorization", `Bearer ${provider.token}`).send({ state_code: "AZ", county_fips: MARICOPA })).status).toBe(201);

  const assign = (propertyId: string) => request(app)
    .put(`/api/provider-assignments/${propertyId}/${provider.organizationId}`)
    .set("Authorization", `Bearer ${customer.token}`)
    .send({ active: true });
  expect((await assign(phoenix.propertyId)).status).toBe(200);
  const refused = await assign(houston.propertyId);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("out_of_area");

  expect((await request(app).post(`/api/geo/branches/${branchId}/areas`).set("Authorization", `Bearer ${provider.token}`).send({ state_code: "TX" })).status).toBe(201);
  expect((await assign(houston.propertyId)).status).toBe(200);

  const tech = await addTech(provider.token);
  expect((await request(app).put(`/api/branches/assignments/${tech.userId}`).set("Authorization", `Bearer ${provider.token}`).send({ branch_id: branchId })).status).toBe(200);
  expect((await request(app).post(`/api/geo/technicians/${tech.userId}/areas`).set("Authorization", `Bearer ${provider.token}`).send({ state_code: "AZ", county_fips: MARICOPA })).status).toBe(201);

  const visible = await request(app).get("/api/portfolio/properties").set("Authorization", `Bearer ${tech.token}`);
  expect(visible.status).toBe(200);
  const ids = visible.body.map((row: { id: string }) => row.id);
  expect(ids).toContain(phoenix.propertyId);
  expect(ids).not.toContain(houston.propertyId);

  const owner = await request(app).get("/api/portfolio/properties").set("Authorization", `Bearer ${customer.token}`);
  expect(owner.body.map((row: { id: string }) => row.id).sort()).toEqual([houston.propertyId, phoenix.propertyId].sort());
  const phoenixRow = owner.body.find((row: { id: string }) => row.id === phoenix.propertyId);
  expect(phoenixRow.county_name).toBe("Maricopa County");
});
