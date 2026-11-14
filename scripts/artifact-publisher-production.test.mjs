import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProductionApiPath,
  packageCommitAllowed,
  PINNED_COMMIT,
  PRODUCTION_SITE_ID,
  productionApproval,
  STAGING_SITE_ID,
  uploadCheckReport,
  uploadProductionDeploy,
} from "./artifact-publisher-production.mjs";

const source = readFileSync(new URL("./artifact-publisher-production.mjs", import.meta.url), "utf8");
const visitorGate = "sso" + "_login";

test("production publish is refused without the approval flag", () => {
  assert.throws(() => productionApproval([]), /refusing_production_approval/);
  assert.throws(() => productionApproval(["--publish-approved"]), /refusing_production_approval/);
  assert.throws(() => productionApproval(["--dry-run"]), /refusing_production_approval/);
  assert.throws(() => productionApproval(["--approve-production-site"]), /refusing_production_approval/);
});

test("staging and any other site are refused", () => {
  assert.throws(() => productionApproval(["--approve-production-site", STAGING_SITE_ID, "--publish-approved"]), /refusing_production_site/);
  assert.throws(() => productionApproval(["--approve-production-site", "other-site", "--dry-run"]), /refusing_production_site/);
  assert.throws(() => assertProductionApiPath(`/api/v1/sites/${STAGING_SITE_ID}`), /refusing_production_site/);
  assert.throws(() => assertProductionApiPath(`/api/v1/accounts/acct/env?site_id=${PRODUCTION_SITE_ID}`), /refusing_env_write/);
  assert.throws(() => assertProductionApiPath(`/api/v1/sites/${PRODUCTION_SITE_ID}?${visitorGate}=false`), /refusing_visitor_gate_change/);
});

test("the production site id is accepted and the visitor gate is not touched", () => {
  assert.equal(productionApproval(["--approve-production-site", PRODUCTION_SITE_ID, "--dry-run"]), PRODUCTION_SITE_ID);
  assert.equal(source.includes(visitorGate), false);
  assert.equal(PINNED_COMMIT, "bc7c4b975a5e7a694dbe2ad8208f7bc323eb8b71");
  assert.equal(packageCommitAllowed(PINNED_COMMIT), true);
  assert.equal(assertProductionApiPath(`/api/v1/sites/${PRODUCTION_SITE_ID}`), `/api/v1/sites/${PRODUCTION_SITE_ID}`);
});

test("upload-check refuses a file map that is missing the api routes", () => {
  const report = uploadCheckReport(
    { files: { "/netlify.toml": "abc" }, byHash: { abc: [{ rel: "/netlify.toml" }] } },
    { functions: {}, functionsConfig: { api: { routes: ["/health"], invocation_mode: "stream" } }, byHash: {} },
  );
  assert.equal(report.ok, false);
  assert.equal(report.writesEnv, false);
  assert.equal(report.changesVisitorGate, false);
  assert.ok(report.problems.includes("missing_api_routes"));
});

test("a mocked upload posts only to the production site and checks the file digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oi-prod-pub-"));
  const file = join(dir, "netlify.toml");
  writeFileSync(file, "site = true\n");
  const sha = createHash("sha1").update(readFileSync(file)).digest("hex");
  const deployId = "a".repeat(24);
  const liveId = "b".repeat(24);
  const calls = [];
  const request = async (method, path, _token, body) => {
    assertProductionApiPath(path);
    calls.push({ method, path, body: typeof body === "string" ? body : null });
    assert.equal(path.includes(STAGING_SITE_ID), false);
    assert.equal(path.toLowerCase().includes(visitorGate), false);
    assert.equal(/\/env(?:\/|$|\?)/.test(path), false);
    if (method === "GET" && path === `/api/v1/sites/${PRODUCTION_SITE_ID}`) {
      const published = calls.some((call) => call.method === "POST" && call.path.endsWith("/restore"));
      return { status: 200, body: Buffer.from(JSON.stringify({
        id: PRODUCTION_SITE_ID,
        published_deploy: { id: published ? deployId : liveId, locked: true, context: "production" },
      })) };
    }
    if (method === "POST" && path.startsWith(`/api/v1/sites/${PRODUCTION_SITE_ID}/deploys?`)) {
      const parsed = JSON.parse(body);
      assert.equal(parsed.draft, false);
      assert.equal(parsed.async, true);
      assert.equal(parsed.files["/netlify.toml"], sha);
      return { status: 200, body: Buffer.from(JSON.stringify({
        id: deployId,
        site_id: PRODUCTION_SITE_ID,
        state: "prepared",
        context: "production",
        required: [sha],
        required_functions: [],
      })) };
    }
    if (method === "PUT" && path.startsWith(`/api/v1/deploys/${deployId}/files/`)) {
      return { status: 200, body: Buffer.from("") };
    }
    if (method === "GET" && path === `/api/v1/sites/${PRODUCTION_SITE_ID}/deploys/${deployId}`) {
      return { status: 200, body: Buffer.from(JSON.stringify({
        id: deployId,
        site_id: PRODUCTION_SITE_ID,
        state: "ready",
        context: "production",
        required: [],
        required_functions: [],
        ssl_url: `https://${deployId}--oi-production.netlify.app`,
        available_functions: [{ name: "api", invocation_mode: "stream", routes: ["/health", "/api/*"] }],
      })) };
    }
    if (method === "POST" && path === `/api/v1/sites/${PRODUCTION_SITE_ID}/deploys/${deployId}/restore`) {
      return { status: 200, body: Buffer.from("{}") };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  try {
    const journal = await uploadProductionDeploy({
      request,
      token: "test-token",
      fileMap: { files: { "/netlify.toml": sha }, byHash: { [sha]: [{ rel: "/netlify.toml", path: file }] } },
      functionMap: {
        functions: {},
        functionsConfig: { api: { routes: ["/health", "/api/*"], invocation_mode: "stream" } },
        byHash: {},
      },
      journal: { state: "attempt-prepared", siteId: PRODUCTION_SITE_ID },
      sleep: async () => {},
      probe: async () => ({ status: 401, contentType: "application/json", body: "{\"error\":\"unauthorized\"}" }),
    });
    assert.equal(journal.state, "published");
    assert.equal(journal.publishedDeployId, deployId);
    assert.equal(journal.rollbackDeployId, liveId);
    assert.equal(journal.writesEnv, false);
    assert.equal(journal.changesVisitorGate, false);
    assert.equal(journal.privacyGate, false);
    assert.deepEqual(journal.uploads.map((item) => item.sha), [sha]);
    assert.ok(calls.some((call) => call.method === "POST" && call.path.startsWith(`/api/v1/sites/${PRODUCTION_SITE_ID}/deploys?`)));
    assert.equal(calls.some((call) => call.path.includes(STAGING_SITE_ID)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
