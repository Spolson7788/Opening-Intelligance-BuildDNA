import { describe, expect, it } from "vitest";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { serverlessPoolConfig } from "../src/db/connectionConfig";
import { PRODUCTION_RECOGNITION_SITE_ID, recognitionFeaturesEnabledForSite } from "../src/services/recognitionSite";

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
  it("production recognition and Measure turn on only with both launch flags", () => {
    const off = {};
    const both = { OI_RECOGNITION_ENABLED: "true", OI_MEASUREMENT_READER: "anthropic" };
    expect(recognitionFeaturesEnabledForSite(PRODUCTION_RECOGNITION_SITE_ID, both)).toBe(true);
    expect(recognitionFeaturesEnabledForSite(PRODUCTION_RECOGNITION_SITE_ID, off)).toBe(false);
    expect(recognitionFeaturesEnabledForSite(PRODUCTION_RECOGNITION_SITE_ID, { OI_RECOGNITION_ENABLED: "true" })).toBe(false);
    expect(recognitionFeaturesEnabledForSite(PRODUCTION_RECOGNITION_SITE_ID, { OI_MEASUREMENT_READER: "anthropic" })).toBe(false);
    expect(recognitionFeaturesEnabledForSite(PRODUCTION_RECOGNITION_SITE_ID, { OI_RECOGNITION_ENABLED: "true", OI_MEASUREMENT_READER: "mock" })).toBe(false);
    expect(recognitionFeaturesEnabledForSite("b64bf33c-a131-4ae2-b2b0-9aec16e9f77b", off)).toBe(true);
    expect(recognitionFeaturesEnabledForSite("80fbbee8-b9d3-4b16-b93f-d2d8396591ec", off)).toBe(true);
  });
  it("other site ids stay off even when the launch flags are set", () => {
    const both = { OI_RECOGNITION_ENABLED: "true", OI_MEASUREMENT_READER: "anthropic" };
    for (const siteId of ["", "other-site", "b64bf33c-a131-4ae2-b2b0-9aec16e9f77c", "00000000-0000-0000-0000-000000000000"]) {
      expect(recognitionFeaturesEnabledForSite(siteId, both), siteId).toBe(false);
    }
  });
  it("the production Netlify entry follows the flags and still holds legacy documents", async () => {
    const s = readFileSync("netlify/functions/api.ts", "utf8");
    expect(s).toContain("recognitionFeaturesEnabled: recognitionFeaturesEnabledForSite(context?.site?.id, process.env),");
    expect(s).toContain('legacyDocumentsEnabled: !["b64bf33c-a131-4ae2-b2b0-9aec16e9f77b","b4e0fc62-86ce-4a26-9ebf-26d7386f4b01"].includes(context?.site?.id ?? ""),');
    const { default: apiHandler } = await import("../netlify/functions/api");
    const previous = {
      OI_RECOGNITION_ENABLED: process.env.OI_RECOGNITION_ENABLED,
      OI_MEASUREMENT_READER: process.env.OI_MEASUREMENT_READER,
    };
    const setFlags = (enabled: boolean) => {
      if (enabled) {
        process.env.OI_RECOGNITION_ENABLED = "true";
        process.env.OI_MEASUREMENT_READER = "anthropic";
      } else {
        delete process.env.OI_RECOGNITION_ENABLED;
        delete process.env.OI_MEASUREMENT_READER;
      }
    };
    const recognition = (siteId: string) => apiHandler(
      new Request("https://example.invalid/api/recognition/runs"),
      { site: { id: siteId } } as Parameters<typeof apiHandler>[1],
    );
    try {
      setFlags(false);
      const closed = await recognition(PRODUCTION_RECOGNITION_SITE_ID);
      expect(closed.status).toBe(404);
      expect(await closed.json()).toEqual({ error: "feature_disabled" });
      setFlags(true);
      const open = await recognition(PRODUCTION_RECOGNITION_SITE_ID);
      expect(open.status).toBe(401);
      const refused = await recognition("00000000-0000-0000-0000-000000000000");
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: "feature_disabled" });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
