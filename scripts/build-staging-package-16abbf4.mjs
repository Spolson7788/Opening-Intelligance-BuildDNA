// Offline package for the PR 19 app commit f11b17d197983f101a49af381976b458ffda295e, or a publisher-only commit after it.
// Does not deploy, does not read or print secrets, and does not migrate.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFacilityDashboard } from './build-facility-dashboard.mjs';
import { hashTree, assertHeadCommit, packageChecksum } from './artifact-publisher-staging-16abbf4.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.env.NETLIFY === 'true') throw new Error('This package is built on a PC. Refusing to run inside Netlify.');
const builtCommit = assertHeadCommit(root);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args, dir = root, extra = {}) {
  const command = process.platform === 'win32' ? process.execPath : npm;
  const commandArgs = process.platform === 'win32'
    ? [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args]
    : args;
  execFileSync(command, commandArgs, { cwd: dir, stdio: 'inherit', env: { ...process.env, ...extra } });
}

run(['ci', '--include=dev']);
run(['run', 'build']);
for (const app of ['field-app', 'dashboard']) {
  const dir = resolve(root, app);
  run(['ci', '--include=dev'], dir);
  const base = app === 'field-app' ? '/field/' : '/dashboard/';
  const tasks = app === 'field-app' ? { VITE_OI_TECH_TASKS: 'true' } : {};
  run(['run', 'build', '--', '--base', base], dir, { OI_UI_BASE: base, VITE_API_BASE_URL: '/api', ...tasks });
}

const output = resolve(root, 'dist/staging-package-16abbf4');
const staging = mkdtempSync(resolve(root, 'dist/staging-build-'));
const publish = resolve(staging, 'publish');
mkdirSync(publish, { recursive: true });
cpSync(resolve(root, 'netlify/public'), publish, { recursive: true });
cpSync(resolve(root, 'field-app/dist'), resolve(publish, 'field'), { recursive: true });
cpSync(resolve(root, 'dashboard/dist'), resolve(publish, 'dashboard'), { recursive: true });
buildFacilityDashboard(resolve(publish, 'facility-dashboard'), { production: false });
writeFileSync(resolve(publish, 'build-info.json'), JSON.stringify({
  environment: 'staging',
  site: 'oi-video-workflows-staging',
  commit: builtCommit,
  releaseStatus: 'staging-publish-prepared',
}, null, 2) + '\n');
writeFileSync(resolve(publish, '_redirects'),
  '/ /dashboard/ 302!\n/field/* /field/index.html 200\n/dashboard/* /dashboard/index.html 200\n');

const trackedSources = ['netlify.toml', 'netlify/functions', 'plugins/function-evidence'];
const files = {
  ...hashTree(publish, 'publish'),
};
for (const source of trackedSources) files[`source:${source}`] = { tree: hashTree(resolve(root, source), source) };
const packageSha256 = packageChecksum(builtCommit, files);
const pin = { commit: builtCommit, packageSha256, files };
writeFileSync(resolve(staging, 'package-pin.json'), JSON.stringify(pin, null, 2) + '\n');
rmSync(output, { recursive: true, force: true });
renameSync(staging, output);
console.log(JSON.stringify({ package: 'dist/staging-package-16abbf4', commit: builtCommit, packageSha256 }, null, 2));
