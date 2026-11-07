// One staging publish of commit 16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5.
// Hard-locked to oi-video-workflows-staging. Refuses production. One attempt.
// Does not print secrets. Default is a dry run; publish requires --publish-approved.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, closeSync } from 'node:fs';
import https from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const PINNED_COMMIT = '16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5';
export const STAGING_SITE_ID = 'b64bf33c-a131-4ae2-b2b0-9aec16e9f77b';
export const STAGING_SITE_NAME = 'oi-video-workflows-staging';
export const STAGING_URL = 'https://oi-video-workflows-staging.netlify.app';
export const PRODUCTION_SITE_ID = 'b4e0fc62-86ce-4a26-9ebf-26d7386f4b01';
export const DEFAULT_NETLIFY_CLI_DIR = 'C:\\Users\\spols\\Documents\\Codex\\2026-10-23\\task\\.local-netlify-cli\\node_modules\\netlify-cli';
const NETLIFY_CLI_VERSION = '27.14.2';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageDir = resolve(root, 'dist/staging-package-16abbf4');
const journalDir = resolve(root, 'dist/staging-publish-journal-16abbf4-r7');
const resumePath = resolve(journalDir, 'resume-attempt.json');
const ROLLBACK_DEPLOY_ID = '6aef3f786cc2af03c2ef1cd0';
const rollbackDir = resolve(root, 'dist/staging-publish-journal-16abbf4-rollback');
const rollbackAttempt = resolve(rollbackDir, 'rollback-attempt.json');
const PRIOR_JOURNALS = [
  'dist/staging-publish-journal-16abbf4/publication-attempt.json',
  'dist/staging-publish-journal-16abbf4-r2/publication-attempt.json',
  'dist/staging-publish-journal-16abbf4-r3/publication-attempt.json',
  'dist/staging-publish-journal-16abbf4-r4/publication-attempt.json',
  'dist/staging-publish-journal-16abbf4-r5/publication-attempt.json',
  'dist/staging-publish-journal-16abbf4-r6/publication-attempt.json',
  'dist/staging-publish-journal-16abbf4-r7/publication-attempt.json',
];
const failurePath = resolve(journalDir, 'failure.json');
const attemptPath = resolve(journalDir, 'publication-attempt.json');
const dryRunPath = resolve(journalDir, 'publication-dry-run.json');

export function hashTree(directory, prefix = '') {
  if (!existsSync(directory)) return {};
  const name = prefix.replace(/\\/g, '/');
  if (statSync(directory).isFile()) {
    const bytes = readFileSync(directory);
    return { [name]: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } };
  }
  const out = {};
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const child = `${name}/${entry.name}`.replace(/\\/g, '/');
    if (entry.isDirectory()) Object.assign(out, hashTree(path, child));
    else {
      const bytes = readFileSync(path);
      out[child] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    }
  }
  return out;
}

const PUBLISHER_FILES = new Set([
  'docs/ops/STAGING-PUBLISH-16abbf4.md',
  'scripts/artifact-publisher-staging-16abbf4.mjs',
  'scripts/artifact-publisher-staging-16abbf4.test.mjs',
  'scripts/build-staging-package-16abbf4.mjs',
]);

export function assertHeadCommit(repo = root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  if (head === PINNED_COMMIT) return head;
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', PINNED_COMMIT, head], { cwd: repo });
  const diff = execFileSync('git', ['diff', '--name-only', PINNED_COMMIT, head], { cwd: repo, encoding: 'utf8' })
    .split('\n').map((line) => line.trim()).filter(Boolean);
  if (ancestor.status !== 0 || diff.some((path) => !PUBLISHER_FILES.has(path))) {
    const error = new Error('refusing_commit_mismatch');
    error.code = 'refusing_commit_mismatch';
    throw error;
  }
  return head;
}

export function assertSite(site) {
  const id = site?.id || '';
  const name = site?.name || '';
  const url = site?.url || site?.ssl_url || '';
  if (id === PRODUCTION_SITE_ID || /production/i.test(name) || /oi-production/i.test(url)) {
    const error = new Error('refusing_production');
    error.code = 'refusing_production';
    throw error;
  }
  let host = '';
  try { host = url ? new URL(url).hostname : ''; } catch { host = ''; }
  if (id !== STAGING_SITE_ID || name !== STAGING_SITE_NAME || (host && host !== 'oi-video-workflows-staging.netlify.app')) {
    const error = new Error('refusing_site_mismatch');
    error.code = 'refusing_site_mismatch';
    throw error;
  }
  return { id, name, url: STAGING_URL };
}

function trackedDirty(repo = root) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  return out.split('\n').map((line) => line.trimEnd()).filter(Boolean).filter((line) => !line.slice(3).trim().startsWith('dist/'));
}

function readPin() {
  const pinPath = resolve(packageDir, 'package-pin.json');
  if (!existsSync(pinPath)) {
    const error = new Error('package_not_built');
    error.code = 'package_not_built';
    throw error;
  }
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (pin.commit !== PINNED_COMMIT) {
    const error = new Error('refusing_package_commit');
    error.code = 'refusing_package_commit';
    throw error;
  }
  const files = {
    ...hashTree(resolve(packageDir, 'publish'), 'publish'),
  };
  for (const source of ['netlify.toml', 'netlify/functions', 'plugins/function-evidence']) {
    files[`source:${source}`] = { tree: hashTree(resolve(root, source), source) };
  }
  const packageSha256 = createHash('sha256').update(JSON.stringify({ commit: PINNED_COMMIT, files })).digest('hex');
  if (packageSha256 !== pin.packageSha256) {
    const error = new Error('refusing_package_checksum');
    error.code = 'refusing_package_checksum';
    throw error;
  }
  return { packageSha256, fileCount: Object.keys(files).length };
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function netlifyCliDir(argv = process.argv) {
  const index = argv.indexOf('--netlify-cli-dir');
  return index >= 0 && argv[index + 1] ? argv[index + 1] : DEFAULT_NETLIFY_CLI_DIR;
}

export function assertStagingApiPath(path, deployId) {
  if (path.includes(PRODUCTION_SITE_ID)) throw fail('refusing_production');
  const site = `/api/v1/sites/${STAGING_SITE_ID}`;
  const deploy = deployId ? `/api/v1/deploys/${deployId}` : '';
  const allowed = path === site || path.startsWith(`${site}/`) || path.startsWith(`${site}?`)
    || (deploy && (path === deploy || path.startsWith(`${deploy}/`) || path.startsWith(`${deploy}?`)));
  if (!allowed) throw fail('refusing_site_mismatch');
  return path;
}

function devUtilsPath(cliDir) {
  const candidates = [
    resolve(cliDir, 'node_modules/@netlify/dev-utils/dist/main.js'),
    resolve(cliDir, '../@netlify/dev-utils/dist/main.js'),
  ];
  return candidates.find((path) => existsSync(path)) || null;
}

async function loadDevUtils(cliDir) {
  const pkgPath = resolve(cliDir, 'package.json');
  if (!existsSync(pkgPath) || !existsSync(resolve(cliDir, 'bin/run.js'))) throw fail('netlify_cli_not_found');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== 'netlify-cli' || pkg.version !== NETLIFY_CLI_VERSION) throw fail('netlify_cli_version_mismatch');
  const utils = devUtilsPath(cliDir);
  if (!utils) throw fail('netlify_dev_utils_not_found');
  return import(pathToFileURL(utils).href);
}

async function authorize(cliDir) {
  const { getGlobalConfigStore, getAPIToken } = await loadDevUtils(cliDir);
  const store = await getGlobalConfigStore();
  const userId = store.get('userId');
  if (typeof userId !== 'string' || !userId.trim()) throw fail('auth_required');
  const token = await getAPIToken();
  if (typeof token !== 'string' || token.length < 8) throw fail('auth_required');
  return token;
}

export function classifyUploadResponse(status, body) {
  const text = String(body || '');
  if (status >= 200 && status < 300) return 'ok';
  if (/not preparing|deploy must be in/i.test(text)) return 'wait-prepared';
  if (status === 500 && /could not authenticate request/i.test(text)) return 'retry-same-token';
  if (status === 401 || status === 403) return 'auth_required';
  return 'upload-failed';
}

export function functionUploadHeaders(token, retryCount = 0) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    ...(retryCount > 0 ? { 'x-nf-retry-count': String(retryCount) } : {}),
  };
}

function stagingRequest(method, path, token, body, contentType = 'application/json', retryCount = 0) {
  assertStagingApiPath(path, path.includes('/api/v1/deploys/') ? path.split('/')[4] : undefined);
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolvePromise, reject) => {
    const req = https.request({
      host: 'api.netlify.com',
      method,
      path,
      headers: {
        ...functionUploadHeaders(token, retryCount),
        ...(payload ? { 'content-type': contentType, 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', () => reject(fail('site_lookup_failed')));
    req.end(payload);
  });
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bnf_[A-Za-z0-9_]+\b/g, 'nf_[redacted]')
    .replace(/("(?:access_token|token|authorization|password|secret)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .slice(0, 8000);
}

function saveFailure(failure, response, extra = {}) {
  mkdirSync(journalDir, { recursive: true });
  writeJson(failurePath, {
    failure,
    branch: extra.branch || null,
    missingHash: extra.missingHash || null,
    status: response?.status ?? null,
    body: sanitize(response?.body?.toString?.('utf8') ?? ''),
    stdout: sanitize(extra.stdout),
    stderr: sanitize(extra.stderr),
    at: new Date().toISOString(),
  });
}

function missingUpload(branch, missingHash) {
  saveFailure('deploy_upload_failed', null, { branch, missingHash });
  throw fail('deploy_upload_failed');
}

async function readLiveDeploy(cliDir) {
  const token = await authorize(cliDir);
  const response = await stagingRequest('GET', `/api/v1/sites/${STAGING_SITE_ID}`, token);
  if (response.status === 401 || response.status === 403) throw fail('auth_required');
  if (response.status === 404) throw fail('auth_account_mismatch');
  if (response.status !== 200) throw fail('site_lookup_failed');
  let site;
  try { site = JSON.parse(response.body.toString('utf8')); }
  catch { throw fail('site_lookup_failed'); }
  assertSite({ id: site.id, name: site.name, url: site.ssl_url || site.url });
  const account = `${site.account_slug || ''} ${site.account_name || ''}`;
  if (/production/i.test(account)) throw fail('refusing_production');
  const deploy = site.published_deploy || {};
  return {
    rollbackDeployId: deploy.id || null,
    rollbackCommit: deploy.commit_ref || null,
    rollbackPermalink: deploy.id ? `https://${deploy.id}--oi-video-workflows-staging.netlify.app` : null,
  };
}

function remember(byHash, sha, value) {
  if (!byHash[sha]) byHash[sha] = [];
  byHash[sha].push(value);
}

export function fileDigestKey(rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((part) => !part || part === '.' || part === '..')) throw fail('invalid_file_path');
  return `/${clean}`;
}

export function fileUploadPath(deployId, digestKey) {
  const rel = fileDigestKey(digestKey).slice(1);
  return `/api/v1/deploys/${deployId}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function includeNetlifyToml(fileMap, tomlPath) {
  const bytes = readFileSync(tomlPath);
  const sha = createHash('sha1').update(bytes).digest('hex');
  const key = fileDigestKey('netlify.toml');
  const byHash = {};
  for (const [hash, entries] of Object.entries(fileMap.byHash || {})) byHash[hash] = [...entries];
  const files = { ...fileMap.files, [key]: sha };
  remember(byHash, sha, { rel: key, path: tomlPath });
  return { files, byHash };
}

export function productionDeployBody({ files, functions, functionsConfig, schedules }) {
  const body = {
    files, functions, functions_config: functionsConfig, draft: false, async: true,
  };
  if (schedules?.length) body.function_schedules = schedules;
  return body;
}

function routeList(fn) {
  const raw = fn?.ro ?? fn?.routes ?? fn?.config?.path ?? fn?.config?.routes ?? null;
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw : [];
}

export function functionRoutePatternsFromDeploy(deploy) {
  const patterns = [];
  const sources = [];
  if (Array.isArray(deploy?.available_functions)) sources.push(...deploy.available_functions);
  if (Array.isArray(deploy?.functions)) sources.push(...deploy.functions);
  const configured = deploy?.functions_config;
  if (configured && typeof configured === 'object') {
    for (const [name, config] of Object.entries(configured)) sources.push({ name, ...(config || {}) });
  }
  for (const fn of sources) {
    const name = fn.n || fn.name;
    if (name && name !== 'api') continue;
    for (const route of routeList(fn)) patterns.push(routePattern(route));
  }
  return patterns;
}

export function apiFunctionView(deploy) {
  const sources = [];
  if (Array.isArray(deploy?.available_functions)) sources.push(...deploy.available_functions);
  if (Array.isArray(deploy?.functions)) sources.push(...deploy.functions);
  if (deploy?.functions_config?.api) sources.push({ name: 'api', ...deploy.functions_config.api });
  return sources.filter((fn) => (fn.n || fn.name || 'api') === 'api').map((fn) => scrubDeployValue({
    name: fn.n || fn.name || 'api',
    sha: fn.d || fn.sha || null,
    runtime: fn.runtime || null,
    routes: routeList(fn).map(routePattern).filter(Boolean),
  }));
}

export function publishBlocker(deploy) {
  if (!deploy || deploy.state === 'error' || deploy.state === 'canceled') return 'failed';
  if (deploy.state !== 'ready') return 'wait';
  const outstanding = (deploy.required?.length || 0) + (deploy.required_functions?.length || 0);
  if (outstanding > 0) return 'wait';
  if (deploy.context !== 'production') return 'context';
  const routes = functionRoutePatternsFromDeploy(deploy);
  if (!routes.includes('/health') || !routes.includes('/api/*')) return 'routes';
  return 'ok';
}

export function selectPublishSnapshot(responses) {
  return responses.find((deploy) => publishBlocker(deploy) === 'ok') || null;
}

export function assertPublishableDeploy(deploy) {
  if (!deploy || deploy.context !== 'production') throw fail('refusing_deploy_context');
  const routes = functionRoutePatternsFromDeploy(deploy);
  if (!routes.includes('/health') || !routes.includes('/api/*')) throw fail('refusing_missing_routes');
  return { context: deploy.context, routes };
}

export function digestFiles(directory) {
  const files = {};
  const byHash = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      const rel = `${prefix}${entry.name}`.replace(/\\/g, '/');
      if (entry.isDirectory()) walk(path, `${rel}/`);
      else {
        const sha = createHash('sha1').update(readFileSync(path)).digest('hex');
        const key = fileDigestKey(rel);
        files[key] = sha;
        remember(byHash, sha, { rel: key, path });
      }
    }
  };
  walk(directory, '');
  return { files, byHash };
}

export function checkLocalLookups(fileMap, functionMap) {
  const missing = [];
  for (const [rel, sha] of Object.entries(fileMap.files)) {
    if (!(fileMap.byHash[sha] || []).some((entry) => entry.rel === rel)) missing.push({ branch: 'files', missingHash: sha });
  }
  for (const [name, sha] of Object.entries(functionMap.functions)) {
    if (!(functionMap.byHash[sha] || []).some((entry) => entry.name === name)) missing.push({ branch: 'functions', missingHash: sha });
  }
  return missing;
}

async function bundleFunctions(cliDir) {
  const entry = [
    resolve(cliDir, 'node_modules/@netlify/zip-it-and-ship-it/dist/main.js'),
    resolve(cliDir, '../@netlify/zip-it-and-ship-it/dist/main.js'),
  ].find((path) => existsSync(path));
  if (!entry) throw fail('functions_bundle_failed');
  const { zipFunctions } = await import(pathToFileURL(entry).href);
  const tmp = mkdtempSync(resolve(root, 'dist/function-zip-'));
  const built = await zipFunctions([resolve(root, 'netlify/functions')], tmp, { basePath: root });
  const functions = {};
  const byHash = {};
  for (const fn of built) {
    const sha = createHash('sha256').update(readFileSync(fn.path)).digest('hex');
    functions[fn.name] = sha;
    remember(byHash, sha, { name: fn.name, path: fn.path, runtime: fn.runtimeVersion || fn.runtime || 'js' });
  }
  const functionsConfig = {};
  const schedules = [];
  for (const fn of built) {
    const config = functionConfigFromBuild(fn);
    if (Object.keys(config).length) functionsConfig[fn.name] = config;
    if (fn.schedule) schedules.push({ name: fn.name, cron: fn.schedule });
  }
  return { functions, byHash, functionsConfig, schedules, tmp };
}

export function functionConfigFromBuild(fn) {
  const routes = fn.routes || fn.config?.path;
  const payload = {
    display_name: fn.displayName,
    excluded_routes: fn.excludedRoutes,
    generator: fn.generator,
    memory: fn.memory,
    region: fn.region,
    routes,
    build_data: fn.buildData || (fn.bootstrapVersion || fn.runtimeAPIVersion ? { bootstrapVersion: fn.bootstrapVersion, runtimeAPIVersion: fn.runtimeAPIVersion } : undefined),
    priority: fn.priority,
    vcpu: fn.vcpu,
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null));
}

export function routePattern(route) {
  if (typeof route === 'string') return route;
  return route && typeof route.pattern === 'string' ? route.pattern : '';
}

export function apiRoutesOk(functionMap) {
  const patterns = (functionMap.functionsConfig?.api?.routes || []).map(routePattern);
  return patterns.includes('/health') && patterns.includes('/api/*');
}

const SECRET_KEY = /secret|token|password|authorization|credential|api[_-]?key|database_url|private_key|access_key/i;

export function scrubDeployValue(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => scrubDeployValue(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (/Bearer\s+\S+/i.test(value) || /\bnf_[A-Za-z0-9_]{6,}\b/.test(value))) return '[redacted]';
    return value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrubDeployValue(item, depth + 1);
  return out;
}

function envBundling(build) {
  if (!build || typeof build !== 'object') return null;
  const names = build.env || build.envVars || build.included_env || build.node_env_vars;
  const envVarNames = Array.isArray(names) ? names.map(String) : names && typeof names === 'object' ? Object.keys(names).sort() : [];
  return scrubDeployValue({
    bootstrapVersion: build.bootstrapVersion || build.bootstrap_version || null,
    runtimeAPIVersion: build.runtimeAPIVersion || build.runtime_api_version || null,
    bundler: build.bundler || null,
    includedFiles: build.includedFiles || build.included_files || null,
    envVarNames,
  });
}

export function normalizeFunctionRecord(fn) {
  if (!fn || typeof fn !== 'object') return null;
  const name = fn.n || fn.name;
  if (typeof name !== 'string' || !name) return null;
  return scrubDeployValue({
    name,
    sha: fn.d || fn.sha || fn.digest || null,
    runtime: fn.runtime || fn.runtime_version || fn.r || null,
    routes: fn.ro || fn.routes || fn.config?.routes || fn.config?.path || null,
    excluded_routes: fn.er || fn.excluded_routes || fn.excludedRoutes || null,
    generator: fn.g || fn.generator || null,
    region: fn.region || fn.rg || null,
    build_data: envBundling(fn.bd || fn.build_data || fn.buildData),
  });
}

function mergeFunction(current, next) {
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(next)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

export function snapshotFromResponses({ id, deploy, functionLists = [], fileList = [], listStatus = {} }) {
  const byName = new Map();
  const sources = [];
  if (Array.isArray(deploy?.available_functions)) sources.push(...deploy.available_functions);
  if (Array.isArray(deploy?.functions)) sources.push(...deploy.functions);
  if (deploy?.functions_config && typeof deploy.functions_config === 'object') {
    for (const [name, config] of Object.entries(deploy.functions_config)) sources.push({ name, ...(config || {}) });
  }
  for (const list of functionLists) if (Array.isArray(list)) sources.push(...list);
  for (const source of sources) {
    const normalized = normalizeFunctionRecord(source);
    if (!normalized) continue;
    byName.set(normalized.name, mergeFunction(byName.get(normalized.name), normalized));
  }
  const files = {};
  for (const file of Array.isArray(fileList) ? fileList : []) {
    const rel = String(file.path || file.name || '').replace(/^\/+/, '');
    if (rel === '_redirects' || rel === 'netlify.toml' || rel === '_headers' || rel === 'function-package-evidence.json' || rel.startsWith('edge-functions') || rel.includes('redirect')) {
      files[rel] = { sha: file.sha || null, size: file.size ?? null };
    }
  }
  return scrubDeployValue({
    id,
    siteId: deploy?.site_id || null,
    state: deploy?.state || null,
    commit: deploy?.commit_ref || null,
    context: deploy?.context || null,
    framework: deploy?.framework || null,
    title: deploy?.title || null,
    functionSchedules: deploy?.function_schedules || [],
    edgeFunctions: deploy?.edge_functions || null,
    requiredEdgeFunctions: deploy?.required_edge_functions || [],
    redirects: deploy?.redirects || deploy?.summary?.redirects || null,
    functions: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files,
    listStatus,
  });
}

function changedFields(good, bad, keys) {
  const fields = {};
  for (const key of keys) {
    if (JSON.stringify(good?.[key] ?? null) !== JSON.stringify(bad?.[key] ?? null)) fields[key] = { good: good?.[key] ?? null, bad: bad?.[key] ?? null };
  }
  return fields;
}

export function compareDeploySnapshots(good, bad) {
  const differences = [];
  const goodFns = new Map((good.functions || []).map((fn) => [fn.name, fn]));
  const badFns = new Map((bad.functions || []).map((fn) => [fn.name, fn]));
  for (const name of [...new Set([...goodFns.keys(), ...badFns.keys()])].sort()) {
    if (!goodFns.has(name)) differences.push({ kind: 'function', name, change: 'only-in-bad' });
    else if (!badFns.has(name)) differences.push({ kind: 'function', name, change: 'only-in-good' });
    else {
      const fields = changedFields(goodFns.get(name), badFns.get(name), ['sha', 'runtime', 'routes', 'excluded_routes', 'generator', 'region', 'build_data']);
      if (Object.keys(fields).length) differences.push({ kind: 'function', name, change: 'different', fields });
    }
  }
  for (const kind of ['redirects', 'edgeFunctions', 'requiredEdgeFunctions', 'functionSchedules', 'files', 'commit', 'framework', 'context']) {
    if (JSON.stringify(good[kind] ?? null) !== JSON.stringify(bad[kind] ?? null)) {
      differences.push({ kind, good: good[kind] ?? null, bad: bad[kind] ?? null });
    }
  }
  return scrubDeployValue({
    good: good.id, bad: bad.id, siteId: STAGING_SITE_ID, readOnly: true, differences,
  });
}

export function publishWithoutUpload(deploy) {
  if (!deploy || deploy.state === 'error' || deploy.state === 'canceled') return false;
  if (deploy.state === 'ready') return true;
  const required = Array.isArray(deploy.required) ? deploy.required : [];
  const functions = Array.isArray(deploy.required_functions) ? deploy.required_functions : [];
  return deploy.state === 'prepared' && required.length === 0 && functions.length === 0;
}

export function diffReady(deploy) {
  if (!deploy || deploy.state === 'error' || deploy.state === 'canceled' || deploy.state === 'preparing') return false;
  if (publishWithoutUpload(deploy)) return true;
  return deploy.state === 'prepared' || deploy.state === 'uploading' || deploy.state === 'uploaded';
}

export function selectUploadSnapshot(responses) {
  return responses.find((deploy) => diffReady(deploy)) || null;
}

export function readyPublishSteps(deploy) {
  if (!deploy || deploy.state === 'error' || deploy.state === 'canceled') throw fail('resume_not_prepared');
  const steps = [];
  if (!diffReady(deploy)) steps.push('wait-prepared');
  if (deploy.state !== 'ready' && !publishWithoutUpload(deploy)) steps.push('upload');
  if (deploy.state !== 'ready') steps.push('wait-ready');
  steps.push('restore', 'confirm-published');
  return steps;
}

export async function publishReadyDeploy(request, deployId) {
  if (!/^[0-9a-f]{24}$/.test(deployId)) throw fail('invalid_deploy_id');
  const restored = await request('POST', `/api/v1/sites/${STAGING_SITE_ID}/deploys/${deployId}/restore`, '{}');
  if (!restored || restored.status < 200 || restored.status >= 300) {
    const error = fail('deploy_publish_failed');
    error.response = restored || null;
    throw error;
  }
  const siteResponse = await request('GET', `/api/v1/sites/${STAGING_SITE_ID}`);
  if (!siteResponse || siteResponse.status !== 200) {
    const error = fail('deploy_publish_failed');
    error.response = siteResponse || null;
    throw error;
  }
  let site;
  try { site = JSON.parse(siteResponse.body.toString('utf8')); }
  catch { throw fail('deploy_publish_failed'); }
  assertSite({ id: site.id, name: site.name, url: site.ssl_url || site.url });
  const publishedDeploy = site.published_deploy || {};
  const publishedDeployId = publishedDeploy.id || null;
  if (publishedDeployId !== deployId) throw fail('deploy_publish_unconfirmed');
  if (publishedDeploy.context !== 'production') throw fail('refusing_deploy_context');
  return { published: true, publishedDeployId, context: publishedDeploy.context };
}

async function pollDeploy(token, deployId, ready) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await stagingRequest('GET', `/api/v1/sites/${STAGING_SITE_ID}/deploys/${deployId}`, token);
    if (response.status === 401 || response.status === 403) throw fail('auth_required');
    if (response.status !== 200) {
      saveFailure('deploy_poll_failed', response);
      throw fail('deploy_poll_failed');
    }
    last = JSON.parse(response.body.toString('utf8'));
    if (last.state === 'error' || last.state === 'canceled') {
      saveFailure('deploy_not_ready', response);
      throw fail('deploy_not_ready');
    }
    const blocker = publishBlocker(last);
    if (blocker === 'failed') {
      saveFailure('deploy_not_ready', response);
      throw fail('deploy_not_ready');
    }
    if (ready && blocker === 'context') throw fail('refusing_deploy_context');
    if (ready && blocker === 'ok') return last;
    if (!ready && diffReady(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  }
  const apiRoutes = functionRoutePatternsFromDeploy(last || {});
  const failure = ready && last?.state === 'ready' && (!apiRoutes.includes('/health') || !apiRoutes.includes('/api/*'))
    ? 'refusing_missing_routes' : 'deploy_poll_timeout';
  saveFailure(failure, { status: 0, body: Buffer.from(sanitize(JSON.stringify({
    state: last?.state || null, context: last?.context || null, apiRoutes,
    required: last?.required || [], required_functions: last?.required_functions || [],
  }))) });
  throw fail(failure);
}

async function uploadOutstanding(token, deployId, diff, fileMap, functionMap, journal) {
  journal.uploads = journal.uploads || [];
  const put = async (branch, sha, requestPath, bytes, contentType) => {
    let retryCount = 0;
    for (;;) {
      const uploaded = await stagingRequest(requestPath.method, requestPath.path, token, bytes, contentType, retryCount);
      const text = uploaded.body?.toString?.('utf8') || '';
      const kind = classifyUploadResponse(uploaded.status, text);
      journal.uploads.push({ branch, sha, path: requestPath.path.split('?')[0], status: uploaded.status, bytes: bytes.length, retryCount });
      writeJson(journal.attemptPath || attemptPath, journal);
      if (kind === 'ok') return;
      if ((kind === 'wait-prepared' || kind === 'retry-same-token') && retryCount < 3) {
        if (kind === 'wait-prepared') {
          const settled = await pollDeploy(token, deployId, false);
          if (!diffReady(settled)) throw fail('deploy_not_prepared');
        }
        retryCount += 1;
        continue;
      }
      if (kind === 'auth_required') throw fail('auth_required');
      saveFailure(kind === 'wait-prepared' ? 'deploy_not_prepared' : 'deploy_upload_failed', uploaded, { branch, missingHash: sha });
      throw fail(kind === 'wait-prepared' ? 'deploy_not_prepared' : 'deploy_upload_failed');
    }
  };
  for (const sha of diff.required || []) {
    const entries = fileMap.byHash[sha];
    if (!entries?.length) missingUpload('files', sha);
    for (const entry of entries) {
      const bytes = readFileSync(entry.path);
      await put('files', sha, { method: 'PUT', path: `${fileUploadPath(deployId, entry.rel)}?size=${bytes.length}` }, bytes, 'application/octet-stream');
    }
  }
  for (const sha of diff.required_functions || []) {
    const entries = functionMap.byHash[sha];
    if (!entries?.length) missingUpload('functions', sha);
    for (const fn of entries) {
      const bytes = readFileSync(fn.path);
      const uploadPath = `/api/v1/deploys/${deployId}/functions/${encodeURIComponent(fn.name)}?runtime=${encodeURIComponent(fn.runtime)}&size=${bytes.length}`;
      await put('functions', sha, { method: 'PUT', path: uploadPath }, bytes, 'application/zip');
    }
  }
}

function deployFiles() {
  return includeNetlifyToml(digestFiles(resolve(packageDir, 'publish')), resolve(root, 'netlify.toml'));
}

async function uploadDigestDeploy(token, fileMap, functionMap, journal) {
  if (!fileMap.files['/netlify.toml'] || !apiRoutesOk(functionMap)) throw fail('refusing_missing_routes');
  const createBody = productionDeployBody({
    files: fileMap.files,
    functions: functionMap.functions,
    functionsConfig: functionMap.functionsConfig,
    schedules: functionMap.schedules,
  });
  const created = await stagingRequest('POST', `/api/v1/sites/${STAGING_SITE_ID}/deploys?title=${encodeURIComponent(`staging ${PINNED_COMMIT}`)}`, token, JSON.stringify(createBody));
  if (created.status === 401 || created.status === 403) throw fail('auth_required');
  if (created.status !== 200 && created.status !== 201) {
    saveFailure('deploy_create_failed', created);
    throw fail('deploy_create_failed');
  }
  const deploy = JSON.parse(created.body.toString('utf8'));
  if (deploy.site_id && deploy.site_id !== STAGING_SITE_ID) throw fail('refusing_site_mismatch');
  if (deploy.context && deploy.context !== 'production') {
    saveFailure('refusing_deploy_context', { status: created.status, body: Buffer.from(sanitize(JSON.stringify({ context: deploy.context }))) });
    throw fail('refusing_deploy_context');
  }
  const deployId = deploy.id;
  journal.deployId = deployId;
  journal.state = 'response-received';
  writeJson(attemptPath, journal);
  let diff = deploy;
  if (!diffReady(diff)) diff = await pollDeploy(token, deployId, false);
  if (!publishWithoutUpload(diff)) {
    await uploadOutstanding(token, deployId, diff, fileMap, functionMap, journal);
    diff = await pollDeploy(token, deployId, true);
  } else if (diff.state !== 'ready') {
    diff = await pollDeploy(token, deployId, true);
  }
  if (diff.state !== 'ready') {
    saveFailure('deploy_not_ready', { status: 0, body: Buffer.from(sanitize(JSON.stringify({ state: diff.state }))) });
    throw fail('deploy_not_ready');
  }
  try {
    const gate = assertPublishableDeploy(diff);
    journal.context = gate.context;
    journal.routes = gate.routes;
    const confirmation = await publishReadyDeploy((method, path, body) => stagingRequest(method, path, token, body), deployId);
    journal.published = confirmation.published;
    journal.publishedDeployId = confirmation.publishedDeployId;
  } catch (error) {
    if (error.response) saveFailure(error.code || 'deploy_publish_failed', error.response);
    throw error;
  }
  return deployId;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

async function runPublish(pin) {
  mkdirSync(journalDir, { recursive: true });
  if (existsSync(attemptPath)) {
    const error = new Error('attempt_already_recorded');
    error.code = 'attempt_already_recorded';
    throw error;
  }
  const dirty = trackedDirty();
  if (dirty.length) {
    const error = new Error('working_tree_dirty');
    error.code = 'working_tree_dirty';
    throw error;
  }
  const live = await readLiveDeploy(netlifyCliDir());
  const created = openSync(attemptPath, 'wx');
  closeSync(created);
  const journal = {
    state: 'attempt-prepared',
    commit: PINNED_COMMIT,
    siteId: STAGING_SITE_ID,
    siteName: STAGING_SITE_NAME,
    packageSha256: pin.packageSha256,
    ...live,
    createdAt: new Date().toISOString(),
  };
  writeJson(attemptPath, journal);
  return (async () => {
    const cliDir = netlifyCliDir();
    try {
      const token = await authorize(cliDir);
      const fileMap = deployFiles();
      const functionMap = await bundleFunctions(cliDir);
      const deployId = await uploadDigestDeploy(token, fileMap, functionMap, journal);
      journal.state = 'ready';
      journal.deployId = deployId;
      journal.deployUrl = STAGING_URL;
      journal.stdout = '';
      journal.stderr = '';
      journal.finishedAt = new Date().toISOString();
      writeJson(attemptPath, journal);
      return journal;
    } catch (error) {
      journal.state = 'failed';
      journal.failure = error.code || 'deploy_command_failed';
      journal.stdout = '';
      journal.stderr = sanitize(error.message === error.code ? '' : error.message);
      writeJson(attemptPath, journal);
      if (!existsSync(failurePath)) saveFailure(journal.failure, null, { stderr: journal.stderr });
      throw error;
    }
  })();
}

async function uploadCheck() {
  const pin = readPin();
  const fileMap = deployFiles();
  const functionMap = await bundleFunctions(netlifyCliDir());
  const missing = checkLocalLookups(fileMap, functionMap);
  const routesOk = apiRoutesOk(functionMap);
  const netlifyToml = Boolean(fileMap.files['/netlify.toml']);
  const productionContext = productionDeployBody({ files: fileMap.files, functions: functionMap.functions, functionsConfig: functionMap.functionsConfig }).draft === false;
  mkdirSync(journalDir, { recursive: true });
  const record = {
    state: missing.length || !routesOk || !netlifyToml || !productionContext ? 'upload-check-failed' : 'upload-check',
    commit: PINNED_COMMIT,
    packageSha256: pin.packageSha256,
    files: Object.keys(fileMap.files).length,
    functions: Object.keys(functionMap.functions).length,
    apiRoutes: functionMap.functionsConfig?.api?.routes || [],
    routesOk,
    netlifyToml,
    draft: false,
    context: 'production',
    missing,
    productionRefused: true,
    createdAt: new Date().toISOString(),
  };
  writeJson(resolve(journalDir, 'upload-check.json'), record);
  console.log(JSON.stringify(record, null, 2));
  if (missing.length || !routesOk || !netlifyToml || !productionContext) process.exitCode = 1;
}

async function rollbackApproved() {
  if (existsSync(rollbackAttempt)) throw fail('attempt_already_recorded');
  const token = await authorize(netlifyCliDir());
  const response = await stagingRequest('GET', `/api/v1/sites/${STAGING_SITE_ID}/deploys/${ROLLBACK_DEPLOY_ID}`, token);
  if (response.status === 401 || response.status === 403) throw fail('auth_required');
  if (response.status !== 200) {
    mkdirSync(rollbackDir, { recursive: true });
    writeJson(resolve(rollbackDir, 'failure.json'), { failure: 'inspect_failed', status: response.status, body: sanitize(response.body.toString('utf8')) });
    throw fail('inspect_failed');
  }
  const deploy = JSON.parse(response.body.toString('utf8'));
  if (deploy.id !== ROLLBACK_DEPLOY_ID || (deploy.site_id && deploy.site_id !== STAGING_SITE_ID)) throw fail('refusing_site_mismatch');
  mkdirSync(rollbackDir, { recursive: true });
  closeSync(openSync(rollbackAttempt, 'wx'));
  const journal = { state: 'rollback-prepared', deployId: ROLLBACK_DEPLOY_ID, siteId: STAGING_SITE_ID, createdAt: new Date().toISOString() };
  writeJson(rollbackAttempt, journal);
  const restored = await stagingRequest('POST', `/api/v1/sites/${STAGING_SITE_ID}/deploys/${ROLLBACK_DEPLOY_ID}/restore`, token, '{}');
  if (restored.status < 200 || restored.status >= 300) {
    journal.state = 'failed';
    journal.failure = 'deploy_publish_failed';
    journal.status = restored.status;
    journal.body = sanitize(restored.body.toString('utf8'));
    writeJson(rollbackAttempt, journal);
    throw fail('deploy_publish_failed');
  }
  journal.state = 'ready';
  journal.finishedAt = new Date().toISOString();
  writeJson(rollbackAttempt, journal);
  console.log(JSON.stringify({ state: 'ready', deployId: ROLLBACK_DEPLOY_ID, siteId: STAGING_SITE_ID }, null, 2));
}

function recordedDeployIds() {
  const ids = new Set();
  for (const rel of PRIOR_JOURNALS) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue;
    try {
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof journal.deployId === 'string' && /^[0-9a-f]{24}$/.test(journal.deployId)) ids.add(journal.deployId);
    } catch { /* an unreadable journal does not authorize a resume */ }
  }
  return ids;
}

function resumeAlreadyPublished() {
  if (!existsSync(resumePath)) return false;
  try { return JSON.parse(readFileSync(resumePath, 'utf8')).published === true; }
  catch { return true; }
}

async function resumeDeploy(deployId) {
  if (!/^[0-9a-f]{24}$/.test(deployId)) throw fail('invalid_deploy_id');
  if (!recordedDeployIds().has(deployId)) throw fail('resume_deploy_unknown');
  if (resumeAlreadyPublished()) throw fail('attempt_already_recorded');
  const pin = readPin();
  const token = await authorize(netlifyCliDir());
  const response = await stagingRequest('GET', `/api/v1/sites/${STAGING_SITE_ID}/deploys/${deployId}`, token);
  if (response.status === 401 || response.status === 403) throw fail('auth_required');
  if (response.status !== 200) {
    saveFailure('inspect_failed', response);
    throw fail('inspect_failed');
  }
  const deploy = JSON.parse(response.body.toString('utf8'));
  if (deploy.site_id && deploy.site_id !== STAGING_SITE_ID) throw fail('refusing_site_mismatch');
  if (deploy.context && deploy.context !== 'production') throw fail('refusing_deploy_context');
  readyPublishSteps(deploy);
  mkdirSync(journalDir, { recursive: true });
  const journal = {
    state: 'resume-prepared', attemptPath: resumePath, deployId, commit: PINNED_COMMIT, siteId: STAGING_SITE_ID,
    packageSha256: pin.packageSha256, required: deploy.required || [], required_functions: deploy.required_functions || [],
    uploads: [], published: false, createdAt: new Date().toISOString(),
  };
  writeJson(resumePath, journal);
  try {
    const cliDir = netlifyCliDir();
    let current = deploy;
    if (!diffReady(current)) current = await pollDeploy(token, deployId, false);
    if (current.state !== 'ready' && !publishWithoutUpload(current)) {
      await uploadOutstanding(token, deployId, current, deployFiles(), await bundleFunctions(cliDir), journal);
    }
    current = await pollDeploy(token, deployId, true);
    const gate = assertPublishableDeploy(current);
    const confirmation = await publishReadyDeploy((method, path, body) => stagingRequest(method, path, token, body), deployId);
    journal.state = 'ready';
    journal.context = confirmation.context || gate.context;
    journal.published = confirmation.published;
    journal.publishedDeployId = confirmation.publishedDeployId;
    journal.finishedAt = new Date().toISOString();
    writeJson(resumePath, journal);
    console.log(JSON.stringify({
      state: 'ready', deployId, siteId: STAGING_SITE_ID, uploads: journal.uploads.length,
      published: journal.published, publishedDeployId: journal.publishedDeployId, context: journal.context,
    }, null, 2));
  } catch (error) {
    journal.state = 'failed';
    journal.published = false;
    journal.failure = error.code || 'deploy_upload_failed';
    if (error.response) saveFailure(journal.failure, error.response);
    writeJson(resumePath, journal);
    throw error;
  }
}

async function readJsonGet(path, token) {
  const response = await stagingRequest('GET', path, token);
  if (response.status === 401 || response.status === 403) throw fail('auth_required');
  let body = null;
  try { body = JSON.parse(response.body.toString('utf8')); } catch { body = null; }
  return { status: response.status, body };
}

async function compareDeploys(goodId, badId) {
  if (!/^[0-9a-f]{24}$/.test(goodId) || !/^[0-9a-f]{24}$/.test(badId) || goodId === badId) throw fail('invalid_deploy_id');
  const token = await authorize(netlifyCliDir());
  const load = async (id) => {
    const deployRes = await readJsonGet(`/api/v1/sites/${STAGING_SITE_ID}/deploys/${id}`, token);
    if (deployRes.status !== 200 || !deployRes.body || typeof deployRes.body !== 'object') throw fail('inspect_failed');
    if (deployRes.body.site_id !== STAGING_SITE_ID) throw fail('refusing_site_mismatch');
    const lists = [];
    const listStatus = {};
    for (const path of [`/api/v1/deploys/${id}/functions`, `/api/v1/sites/${STAGING_SITE_ID}/deploys/${id}/functions`]) {
      const got = await readJsonGet(path, token);
      listStatus[path] = got.status;
      if (got.status === 200 && Array.isArray(got.body)) lists.push(got.body);
    }
    const filesRes = await readJsonGet(`/api/v1/deploys/${id}/files`, token);
    listStatus.files = filesRes.status;
    return snapshotFromResponses({
      id, deploy: deployRes.body, functionLists: lists, listStatus,
      fileList: filesRes.status === 200 && Array.isArray(filesRes.body) ? filesRes.body : [],
    });
  };
  const report = compareDeploySnapshots(await load(goodId), await load(badId));
  mkdirSync(journalDir, { recursive: true });
  writeJson(resolve(journalDir, `compare-${goodId.slice(0, 8)}-${badId.slice(0, 8)}.json`), report);
  console.log(JSON.stringify(report, null, 2));
}

async function inspectDeploy(deployId) {
  if (!/^[0-9a-f]{24}$/.test(deployId)) throw fail('invalid_deploy_id');
  const token = await authorize(netlifyCliDir());
  const response = await stagingRequest('GET', `/api/v1/sites/${STAGING_SITE_ID}/deploys/${deployId}`, token);
  if (response.status === 401 || response.status === 403) throw fail('auth_required');
  if (response.status !== 200) {
    saveFailure('inspect_failed', response);
    throw fail('inspect_failed');
  }
  const deploy = JSON.parse(response.body.toString('utf8'));
  if (deploy.site_id && deploy.site_id !== STAGING_SITE_ID) throw fail('refusing_site_mismatch');
  const lists = [];
  for (const path of [`/api/v1/deploys/${deployId}/functions`, `/api/v1/sites/${STAGING_SITE_ID}/deploys/${deployId}/functions`]) {
    const got = await readJsonGet(path, token);
    if (got.status === 200 && Array.isArray(got.body)) lists.push(...got.body);
  }
  const viewed = { ...deploy, functions: [...(Array.isArray(deploy.functions) ? deploy.functions : []), ...lists] };
  const record = {
    state: 'inspect',
    deployId,
    deployState: deploy.state || null,
    context: deploy.context || null,
    apiRoutes: functionRoutePatternsFromDeploy(viewed),
    apiFunctions: apiFunctionView(viewed),
    required: deploy.required || [],
    required_functions: deploy.required_functions || [],
    error_message: deploy.error_message || null,
  };
  mkdirSync(journalDir, { recursive: true });
  writeJson(resolve(journalDir, `inspect-${deployId}.json`), record);
  console.log(JSON.stringify(record, null, 2));
}

async function main() {
  const inspectIndex = process.argv.indexOf('--inspect-deploy');
  const inspectId = inspectIndex >= 0 ? process.argv[inspectIndex + 1] : '';
  const resumeIndex = process.argv.indexOf('--resume-deploy');
  const resumeId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : '';
  const compareIndex = process.argv.indexOf('--compare-deploys');
  const compareGood = compareIndex >= 0 ? process.argv[compareIndex + 1] : '';
  const compareBad = compareIndex >= 0 ? process.argv[compareIndex + 2] : '';
  const compareMode = compareIndex >= 0;
  const uploadCheckMode = process.argv.includes('--upload-check');
  const rollback = process.argv.includes('--rollback-approved');
  const publish = process.argv.includes('--publish-approved');
  const dryRun = process.argv.includes('--dry-run') || (!publish && !uploadCheckMode && !inspectId && !resumeId && !rollback && !compareMode);
  if ([Boolean(inspectId), Boolean(resumeId), uploadCheckMode, publish, rollback, compareMode, process.argv.includes('--dry-run')].filter(Boolean).length > 1) throw fail('choose_one_mode');
  assertHeadCommit(root);
  assertSite({ id: STAGING_SITE_ID, name: STAGING_SITE_NAME, url: STAGING_URL });
  let productionRefused = false;
  try { assertSite({ id: PRODUCTION_SITE_ID, name: 'oi-production', url: 'https://oi-production.netlify.app' }); }
  catch (error) { productionRefused = error.code === 'refusing_production'; }
  if (!productionRefused) throw new Error('production_guard_failed');
  if (compareMode) return compareDeploys(compareGood, compareBad);
  if (inspectId) return inspectDeploy(inspectId);
  if (resumeId) return resumeDeploy(resumeId);
  if (rollback) return rollbackApproved();
  if (uploadCheckMode) return uploadCheck();

  if (!publish) {
    let packageSha256 = null;
    let packageState = 'package_not_built';
    try {
      packageSha256 = readPin().packageSha256;
      packageState = 'package_checksum_matched';
    } catch (error) {
      if (error.code !== 'package_not_built' && error.code !== 'refusing_package_checksum' && error.code !== 'refusing_package_commit') throw error;
      packageState = error.code;
    }
    let rollback = null;
    let rollbackError = null;
    if (packageState === 'package_checksum_matched' || packageState === 'package_not_built') {
      try { rollback = await readLiveDeploy(netlifyCliDir()); }
      catch (error) { rollbackError = error.code || 'cli_login_required'; }
    }
    mkdirSync(journalDir, { recursive: true });
    const record = {
      state: 'dry-run',
      commit: PINNED_COMMIT,
      siteId: STAGING_SITE_ID,
      siteName: STAGING_SITE_NAME,
      packageState,
      packageSha256,
      rollbackDeployId: rollback?.rollbackDeployId || null,
      rollbackPermalink: rollback?.rollbackPermalink || null,
      rollbackError,
      productionRefused: true,
      createdAt: new Date().toISOString(),
    };
    writeJson(dryRunPath, record);
    console.log(JSON.stringify(record, null, 2));
    if (rollbackError) process.exitCode = 1;
    return;
  }
  const pin = readPin();
  const journal = await runPublish(pin);
  console.log(JSON.stringify({ state: journal.state, commit: PINNED_COMMIT, siteId: STAGING_SITE_ID, deployId: journal.deployId || null, rollbackDeployId: journal.rollbackDeployId }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.code || 'publisher_failed');
    process.exit(1);
  });
}
