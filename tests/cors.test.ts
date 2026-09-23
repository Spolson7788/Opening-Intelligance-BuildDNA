import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { corsOriginsFromEnv, createApp } from "../src/app";

const originalEnv = {
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  DEPLOY_URL: process.env.DEPLOY_URL,
  DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL,
  URL: process.env.URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("CORS deployment origins", () => {
  it("includes explicit and Netlify runtime origins without duplicates", () => {
    process.env.CORS_ORIGINS = "https://field.example, https://dashboard.example";
    process.env.DEPLOY_URL = "https://immutable.example";
    process.env.DEPLOY_PRIME_URL = "https://branch.example";
    process.env.URL = "https://field.example";

    expect(corsOriginsFromEnv()).toEqual([
      "https://field.example",
      "https://dashboard.example",
      "https://immutable.example",
      "https://branch.example",
    ]);
  });

  it("allows the current immutable deploy and rejects an unrelated origin", async () => {
    process.env.CORS_ORIGINS = "https://branch.example";
    process.env.DEPLOY_URL = "https://immutable.example";
    delete process.env.DEPLOY_PRIME_URL;
    delete process.env.URL;
    const app = createApp();

    const allowed = await request(app)
      .options("/health")
      .set("Origin", "https://immutable.example")
      .set("Access-Control-Request-Method", "GET");
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://immutable.example");

    const rejected = await request(app)
      .options("/health")
      .set("Origin", "https://unrelated.example")
      .set("Access-Control-Request-Method", "GET");
    expect(rejected.status).toBe(500);
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
