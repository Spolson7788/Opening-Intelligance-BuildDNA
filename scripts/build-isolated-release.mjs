import {createHash} from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolatedReleaseContext } from './isolated-release-context.mjs';
import { buildFacilityDashboard } from './build-facility-dashboard.mjs';

const root = fileURLToPath(new URL("../", import.meta.url));
assertIsolatedReleaseContext(process.env);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args, dir = root, extra = {}) {
  execFileSync(npm, args, {
    cwd: dir, stdio: "inherit", env: { ...process.env, ...extra },
  });
}

// Explicitly install build tools even when NODE_ENV=production.
run(["ci", "--include=dev"]);
run(["run", "build"]);
for (const app of ["field-app", "dashboard"]) {
  const dir = resolve(root, app);
  run(["ci", "--include=dev"], dir);
  const base = app === "field-app" ? "/field/" : "/dashboard/";
  run(["run", "build", "--", "--base", base], dir, {
    OI_UI_BASE: base, VITE_API_BASE_URL: "/api",
  });
}

mkdirSync(resolve(root, "dist"), { recursive: true });
// Preserve any previous generated output instead of deleting it.
const output = resolve(root, "dist/isolated-release");
const staging = mkdtempSync(resolve(root, "dist/staging-build-"));
cpSync(resolve(root, "netlify/public"), staging, { recursive: true });
cpSync(resolve(root, "field-app/dist"), resolve(staging, "field"), { recursive: true });
cpSync(resolve(root, "dashboard/dist"), resolve(staging, "dashboard"), { recursive: true });
buildFacilityDashboard(resolve(staging, "facility-dashboard"));
writeFileSync(resolve(staging, 'build-info.json'), JSON.stringify({
  environment: process.env.CONTEXT === 'production' ? 'isolated-release-validation' : 'reference-staging-validation',
  commit: process.env.COMMIT_REF || execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  branch: process.env.HEAD || process.env.BRANCH || 'local',
  checkoutRef: process.env.BRANCH || 'local',
  context: process.env.CONTEXT || 'local',
  releaseStatus: 'acceptance-pending',
}, null, 2) + '\n');
writeFileSync(resolve(staging, "_redirects"),
  "/field/* /field/index.html 200\n/dashboard/* /dashboard/index.html 200\n");
// Hash the files produced by this Netlify build, not a later local rebuild.
const artifacts = {};
function hashTree(directory, prefix = '') {
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    const path = resolve(directory, entry.name), name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) hashTree(path, name);
    else {const bytes = readFileSync(path); artifacts[name] = {sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};}
  }
}
hashTree(staging);
writeFileSync(resolve(staging, 'deployment-evidence.json'), JSON.stringify({
  commit:process.env.COMMIT_REF, deployId:process.env.DEPLOY_ID, context:process.env.CONTEXT,
  artifactSource:'Netlify build output before platform HTML injection', artifacts
},null,2)+'\n');
if (existsSync(output)) {
  const previous = mkdtempSync(resolve(root, "dist/previous-staging-"));
  renameSync(output, resolve(previous, "package"));
}
renameSync(staging, output);
console.log("Private isolated release frontend package ready; API remains same-origin.");
