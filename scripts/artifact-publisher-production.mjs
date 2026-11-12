// Production publisher for oi-production only.
// Does not publish unless --publish-approved and --approve-production-site are both present.
// Does not read or write the Netlify visitor sign-in gate.
// This commit does not run the script.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_SITE_ID = "b4e0fc62-86ce-4a26-9ebf-26d7386f4b01";
export const PRODUCTION_SITE_NAME = "oi-production";
export const STAGING_SITE_ID = "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b";
export const PINNED_COMMIT = "bc7c4b975a5e7a694dbe2ad8208f7bc323eb8b71";
const APPROVE_FLAG = "--approve-production-site";

const root = fileURLToPath(new URL("..", import.meta.url));
const journalDir = resolve(root, "dist/production-publish-journal");
const publisherFiles = new Set([
  "docs/ops/production-go-live-plan.md",
  "migrations/production/20261112140500_r59_production_schema.sql",
  "migrations/production/20261112140500_r59_production_schema_rollback.sql",
  "scripts/apply-production-schema-bundle.mjs",
  "scripts/artifact-publisher-production.mjs",
  "scripts/artifact-publisher-production.test.mjs",
  "scripts/production-schema-postcheck.mjs",
  "scripts/production-schema-precheck.mjs",
]);

export function productionApproval(argv) {
  const flag = argv.indexOf(APPROVE_FLAG);
  const site = flag >= 0 ? argv[flag + 1] : "";
  if (flag < 0 || !site) {
    const error = new Error("refusing_production_approval");
    error.code = "refusing_production_approval";
    throw error;
  }
  if (site === STAGING_SITE_ID || site !== PRODUCTION_SITE_ID) {
    const error = new Error("refusing_production_site");
    error.code = "refusing_production_site";
    throw error;
  }
  return site;
}

export function packageCommitAllowed(commit, repo = root) {
  if (commit === PINNED_COMMIT) return true;
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", PINNED_COMMIT, commit], { cwd: repo });
  if (ancestor.status !== 0) return false;
  const diff = execFileSync("git", ["diff", "--name-only", PINNED_COMMIT, commit], { cwd: repo, encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean);
  return diff.every((path) => publisherFiles.has(path));
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertClean(repo = root) {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
  if (dirty) throw fail("working_tree_dirty");
}

function readPin() {
  const pinPath = resolve(root, "dist/staging-package-16abbf4/package-pin.json");
  if (!existsSync(pinPath)) throw fail("package_not_built");
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  if (!packageCommitAllowed(pin.commit)) throw fail("refusing_package_commit");
  return pin;
}

export function journalFor(mode, extra = {}) {
  return {
    state: mode,
    siteId: PRODUCTION_SITE_ID,
    siteName: PRODUCTION_SITE_NAME,
    packageCommit: PINNED_COMMIT,
    writesEnv: false,
    changesVisitorGate: false,
    ...extra,
    createdAt: new Date().toISOString(),
  };
}

function writeJournal(name, value) {
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(resolve(journalDir, name), JSON.stringify(value, null, 2) + "\n");
}

export async function main(argv = process.argv.slice(2)) {
  productionApproval(argv);
  const publish = argv.includes("--publish-approved");
  const uploadCheck = argv.includes("--upload-check");
  const diagnose = argv.includes("--diagnose");
  const check = argv.includes("--check-deploy");
  const dryRun = argv.includes("--dry-run") || (!publish && !uploadCheck && !diagnose && !check);
  const modes = [publish, uploadCheck, diagnose, check, argv.includes("--dry-run")].filter(Boolean).length;
  if (modes > 1) throw fail("choose_one_mode");
  assertClean();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!packageCommitAllowed(head)) throw fail("refusing_commit_mismatch");
  if (publish) {
    const pin = readPin();
    const journal = journalFor("publish-approved-not-uploaded", { commit: head, packageSha256: pin.packageSha256 });
    writeJournal("publication-attempt.json", journal);
    throw fail("production_upload_not_wired");
  }
  let packageState = "package_not_built";
  let packageSha256 = null;
  try {
    const pin = readPin();
    packageSha256 = pin.packageSha256;
    packageState = "package_checksum_matched";
  } catch (error) {
    if (!["package_not_built", "refusing_package_commit"].includes(error.code)) throw error;
  }
  const journal = journalFor(dryRun ? "dry-run" : uploadCheck ? "upload-check" : diagnose ? "diagnose" : "check-deploy", {
    commit: head,
    packageState,
    packageSha256,
    readsOnly: !publish,
  });
  writeJournal(dryRun ? "publication-dry-run.json" : `${journal.state}.json`, journal);
  console.log(JSON.stringify(journal, null, 2));
  return journal;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error.code || error.message);
    process.exit(1);
  });
}
