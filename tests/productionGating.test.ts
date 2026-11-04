import { describe, expect, it } from "vitest";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";

describe("production gating", () => {
  it("turns recognition, reference library and recognition usage/billing endpoints off when disabled", async () => {
    const app = createApp({ recognitionFeaturesEnabled: false });
    expect((await request(app).get("/api/features")).status).toBe(401); // signed-in users only
    for (const path of ["/api/recognition/runs", "/api/recognition", "/api/platform/recognition-usage?month=2026-11",
      "/api/platform/recognition-usage/settings", "/api/platform/recognition-run-records/outbox"]) {
      const r = await request(app).get(path);
      expect(r.status, path).toBe(404);
      expect(r.body).toEqual({ error: "feature_disabled" });
    }
    expect((await request(app).post("/api/recognition/runs").send({})).status).toBe(404);
  });
  it("keeps existing behavior by default", async () => {
    const app = createApp();
    expect((await request(app).get("/api/recognition/runs")).status).not.toBe(404);
  });
  it("Netlify entry enables recognition only on the two staging sites", () => {
    const s = readFileSync("netlify/functions/api.ts", "utf8");
    expect(s).toMatch(/recognitionFeaturesEnabled:\['b64bf33c-a131-4ae2-b2b0-9aec16e9f77b','80fbbee8-b9d3-4b16-b93f-d2d8396591ec'\]\.includes\(context\?\.site\?\.id\?\?''\)/);
  });
  it("npm run migrate refuses oi-production without connecting or printing the URL", () => {
    for (const url of ["postgresql://u:secretpw@db.bekaxmatcvxqpjixwsqn.supabase.co:5432/postgres",
      "postgresql://postgres.bekaxmatcvxqpjixwsqn:secretpw@aws-0-us-west-1.pooler.supabase.com:6543/postgres"]) {
      const r = spawnSync(process.execPath, ["scripts/migrate.js"], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 20000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Refusing to run: DATABASE_URL points at oi-production");
      expect(r.stdout + r.stderr).not.toContain("secretpw");
    }
  });
});
