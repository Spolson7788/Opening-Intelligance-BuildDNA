import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productionApproval, packageCommitAllowed, PINNED_COMMIT, PRODUCTION_SITE_ID, STAGING_SITE_ID } from "./artifact-publisher-production.mjs";

const source = readFileSync(new URL("./artifact-publisher-production.mjs", import.meta.url), "utf8");

test("production publish is refused without the approval flag", () => {
  assert.throws(() => productionApproval([]), /refusing_production_approval/);
  assert.throws(() => productionApproval(["--publish-approved"]), /refusing_production_approval/);
  assert.throws(() => productionApproval(["--dry-run"]), /refusing_production_approval/);
  assert.throws(() => productionApproval(["--approve-production-site"]), /refusing_production_approval/);
});

test("staging and any other site are refused", () => {
  assert.throws(() => productionApproval(["--approve-production-site", STAGING_SITE_ID, "--publish-approved"]), /refusing_production_site/);
  assert.throws(() => productionApproval(["--approve-production-site", "other-site", "--dry-run"]), /refusing_production_site/);
});

test("the production site id is accepted and the visitor gate is not touched", () => {
  assert.equal(productionApproval(["--approve-production-site", PRODUCTION_SITE_ID, "--dry-run"]), PRODUCTION_SITE_ID);
  assert.equal(source.includes("sso_login"), false);
  assert.equal(PINNED_COMMIT, "bc7c4b975a5e7a694dbe2ad8208f7bc323eb8b71");
  assert.equal(packageCommitAllowed(PINNED_COMMIT), true);
});
