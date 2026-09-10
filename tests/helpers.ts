import { createApp } from "../src/app";
import request from "supertest";

export const app = createApp();

let counter = 0;
// Unique per call so parallel-ish tests within a file never collide on the
// email uniqueness constraint, without needing per-test DB transactions.
function unique(label: string) {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

export interface TestOrg {
  token: string;
  organizationId: string;
  email: string;
}

export async function signupTestOrg(orgLabel = "Test Org"): Promise<TestOrg> {
  const email = `${unique("user")}@example.com`;
  const res = await request(app).post("/api/auth/signup").send({
    organization_name: `${orgLabel} ${unique("org")}`,
    email,
    password: "testpassword123",
    full_name: "Test Admin",
  });
  if (res.status !== 201) {
    throw new Error(`signupTestOrg failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, organizationId: res.body.organizationId, email };
}

export async function createPortfolioHierarchy(token: string) {
  const portfolio = await request(app)
    .post("/api/portfolio/portfolios")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Test Portfolio" });

  const property = await request(app)
    .post("/api/portfolio/properties")
    .set("Authorization", `Bearer ${token}`)
    .send({ portfolio_id: portfolio.body.id, name: "Test Property", property_type: "multifamily" });

  const building = await request(app)
    .post("/api/portfolio/buildings")
    .set("Authorization", `Bearer ${token}`)
    .send({ property_id: property.body.id, name: "Test Building" });

  return {
    portfolioId: portfolio.body.id as string,
    propertyId: property.body.id as string,
    buildingId: building.body.id as string,
  };
}

export async function createTestOpening(token: string, buildingId: string, overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post("/api/openings")
    .set("Authorization", `Bearer ${token}`)
    .send({
      opening_code: unique("OPEN"),
      building_id: buildingId,
      opening_type: "door",
      ...overrides,
    });
  if (res.status !== 201) {
    throw new Error(`createTestOpening failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}
