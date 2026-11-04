import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFacilityDashboard } from "../scripts/build-facility-dashboard.mjs";
import { isProductionRelease, landingHtml, releaseInfo } from "../scripts/release-wording.mjs";

const prod = { NETLIFY: "true", CONTEXT: "production", SITE_ID: "b4e0fc62-86ce-4a26-9ebf-26d7386f4b01", BRANCH: "release/production" };
const staging = { ...prod, SITE_ID: "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b", BRANCH: "release/video-workflows-staging" };
const landing = readFileSync("netlify/public/index.html", "utf8");
const dash = (production: boolean) => { const d = mkdtempSync(join(tmpdir(), "oi-dash-")); buildFacilityDashboard(d, { production }); return readFileSync(join(d, "index.html"), "utf8"); };
const nonprod = /Nonproduction preview|acceptance pending|acceptance-pending|Synthetic testing only|release candidate|connected staging/i;

describe("production wording", () => {
  it("only the exact oi-production release context counts as production", () => {
    expect(isProductionRelease(prod)).toBe(true);
    for (const patch of [{ NETLIFY: "false" }, { CONTEXT: "deploy-preview" }, { BRANCH: "main" }, { BRANCH: staging.BRANCH }, { SITE_ID: staging.SITE_ID }, { SITE_ID: "80fbbee8-b9d3-4b16-b93f-d2d8396591ec" }])
      expect(isProductionRelease({ ...prod, ...patch })).toBe(false);
    expect(isProductionRelease(staging)).toBe(false);
  });
  it("production landing page and build info carry no nonproduction wording", () => {
    const html = landingHtml(landing, true);
    expect(html).not.toMatch(nonprod);
    expect(html).toContain("Opening Intelligence");
    expect(releaseInfo(true)).toEqual({ environment: "production", releaseStatus: "production" });
  });
  it("staging keeps its current landing wording and release status", () => {
    expect(landingHtml(landing, isProductionRelease(staging))).toBe(landing);
    expect(landing).toContain("acceptance pending. Synthetic testing only.");
    expect(releaseInfo(false)).toEqual({ environment: "isolated-release-validation", releaseStatus: "acceptance-pending" });
  });
  it("production facility dashboard has no preview banner; staging keeps it", () => {
    const p = dash(true), s = dash(false);
    expect(p).not.toMatch(nonprod);
    expect(p).not.toContain("<aside style=\"background:#fff1c8");
    expect(s).toContain("Nonproduction preview — connected acceptance pending.");
    expect(s).toContain("connected staging");
  });
});
