import { describe, expect, it } from "vitest";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { serverlessPoolConfig } from "../src/db/connectionConfig";

describe("production gating", () => {
  it("turns recognition, reference library and recognition usage/billing endpoints off when disabled", async () => {
    const app = createApp({ recognitionFeaturesEnabled: false });
    expect((await request(app).get("/api/features")).status).toBe(401); // signed-in users only
    for (const path of ["/api/recognition/runs", "/api/recognition", "/api/hardware-recognition/runs", "/api/platform/recognition-usage?month=2026-11",
      "/api/platform/recognition-usage/settings", "/api/platform/recognition-run-records/outbox"]) {
      const r = await request(app).get(path);
      expect(r.status, path).toBe(404);
      expect(r.body).toEqual({ error: "feature_disabled" });
    }
    expect((await request(app).post("/api/recognition/runs").send({})).status).toBe(404);
    expect((await request(app).post("/api/hardware-recognition/runs").send({})).body).toEqual({ error: "feature_disabled" });
  });
  it("keeps existing behavior by default", async () => {
    const app = createApp();
    expect((await request(app).get("/api/recognition/runs")).status).not.toBe(404);
    expect((await request(app).post("/api/hardware-recognition/runs").send({})).status).not.toBe(404);
  });
  it("Netlify entry enables recognition only on the two staging sites", () => {
    const s = readFileSync("netlify/functions/api.ts", "utf8");
    expect(s).toMatch(/recognitionFeaturesEnabled:\['b64bf33c-a131-4ae2-b2b0-9aec16e9f77b','80fbbee8-b9d3-4b16-b93f-d2d8396591ec'\]\.includes\(context\?\.site\?\.id\?\?''\)/);
  });
  it("oi-production site never gets recognition and keeps legacy documents off", () => {
    const s = readFileSync("netlify/functions/api.ts", "utf8");
    const rec = s.match(/recognitionFeaturesEnabled:(.*)/)![1];
    expect(rec).not.toContain("b4e0fc62-86ce-4a26-9ebf-26d7386f4b01");
    expect(s).toContain('legacyDocumentsEnabled: !["b64bf33c-a131-4ae2-b2b0-9aec16e9f77b","b4e0fc62-86ce-4a26-9ebf-26d7386f4b01"].includes(context?.site?.id ?? ""),');
  });
  it("legacy document routes are held on the oi-production site", async () => {
    const { default: apiHandler } = await import("../netlify/functions/api");
    const context = { site: { id: "b4e0fc62-86ce-4a26-9ebf-26d7386f4b01" } } as Parameters<typeof apiHandler>[1];
    for (const path of ["/api/documents/presign", "/api/documents"]) {
      const r = await apiHandler(new Request("https://example.invalid" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content_type: "application/pdf" }) }), context);
      expect(r.status, path).toBe(503);
      expect(await r.json()).toEqual({ error: "documents_unavailable" });
    }
  });
  it("database pool profile is allowed for oi-production and still rejects unknown projects", () => {
    const base = { OI_DATABASE_POOL_PROFILE: "isolated-serverless" };
    expect(serverlessPoolConfig({ ...base, DATABASE_URL: "postgresql://postgres.bekaxmatcvxqpjixwsqn:synthetic@aws-0-us-west-1.pooler.supabase.com:6543/postgres" }).max).toBe(1);
    expect(() => serverlessPoolConfig({ ...base, DATABASE_URL: "postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:synthetic@aws-0-us-west-1.pooler.supabase.com:6543/postgres" })).toThrow("database_pool_profile_target_mismatch");
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
