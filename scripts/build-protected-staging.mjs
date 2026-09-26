import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertProtectedStagingContext } from './protected-staging-context.mjs';

const root = fileURLToPath(new URL("../", import.meta.url));
assertProtectedStagingContext(process.env);

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
const output = resolve(root, "dist/protected-staging");
const staging = mkdtempSync(resolve(root, "dist/staging-build-"));
cpSync(resolve(root, "netlify/public"), staging, { recursive: true });
cpSync(resolve(root, "field-app/dist"), resolve(staging, "field"), { recursive: true });
cpSync(resolve(root, "dashboard/dist"), resolve(staging, "dashboard"), { recursive: true });
writeFileSync(resolve(staging, 'build-info.json'), JSON.stringify({
  environment: 'nonproduction',
  commit: process.env.COMMIT_REF || execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  branch: process.env.BRANCH || 'local',
  context: process.env.CONTEXT || 'local',
  releaseStatus: 'acceptance-pending',
}, null, 2) + '\n');
writeFileSync(resolve(staging, "_redirects"),
  "/field/* /field/index.html 200\n/dashboard/* /dashboard/index.html 200\n");
if (existsSync(output)) {
  const previous = mkdtempSync(resolve(root, "dist/previous-staging-"));
  renameSync(output, resolve(previous, "package"));
}
renameSync(staging, output);
console.log("Protected staging frontend package ready; API remains same-origin.");
