import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const siteId = "6430c57d-8a98-43bc-ba25-94007dd244f2";
if (process.env.NETLIFY === "true" && (
  process.env.SITE_ID !== siteId ||
  process.env.BRANCH !== "pr2-staging" ||
  process.env.CONTEXT !== "branch-deploy"
)) {
  throw new Error("Protected staging requires the approved site and pr2-staging branch-deploy context");
}

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
writeFileSync(resolve(staging, "_redirects"),
  "/field/* /field/index.html 200\n/dashboard/* /dashboard/index.html 200\n");
if (existsSync(output)) {
  const previous = mkdtempSync(resolve(root, "dist/previous-staging-"));
  renameSync(output, resolve(previous, "package"));
}
renameSync(staging, output);
console.log("Protected staging frontend package ready; API remains same-origin.");
