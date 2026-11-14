#!/usr/bin/env node
// Production publisher for Netlify site b4e0fc62-86ce-4a26-9ebf-26d7386f4b01.
// Same digest, file-list, upload-check, dry-run, and single --publish-approved path as the
// staging publisher. Does not read or write the Netlify visitor sign-in gate. Does not write
// environment variables or secrets. Does not call the staging site. Does not publish unless
// --publish-approved is passed, and this agent must not pass that flag.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiRoutesOk,
  authorize,
  bundleFunctions,
  checkLocalLookups,
  classifyUploadResponse,
  deployFiles,
  diffReady,
  eagerNativeProblemsForZip,
  fileUploadPath,
  functionShasToUpload,
  functionUploadHeaders,
  functionUploadQuery,
  functionZipProblems,
  hashTree,
  includeNetlifyToml,
  listZipEntryNames,
  isPrivacyGate,
  loginProbeReached,
  needsPublishingLock,
  packageChecksum,
  productionDeployBody,
  publishBlocker,
  publishWithoutUpload,
  assertPublishableDeploy,
  zipUnzippedBytes,
  API_ZIP_MAX_UNZIPPED_BYTES,
  DEFAULT_NETLIFY_CLI_DIR,
} from './artifact-publisher-staging-16abbf4.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = resolve(root, 'dist/staging-package-16abbf4');
const journalDir = resolve(root, 'dist/production-publish-journal');
export const PRODUCTION_SITE_ID = 'b4e0fc62-86ce-4a26-9ebf-26d7386f4b01';
export const STAGING_SITE_ID = 'b64bf33c-a131-4ae2-b2b0-9aec16e9f77b';
export const PINNED_COMMIT = 'bc7c4b975a5e7a694dbe2ad8208f7bc323eb8b71';
const API_HOST = 'api.netlify.com';

const publisherFiles = new Set([
  'docs/ops/production-go-live-plan.md',
  'docs/ops/production-publish-journal-template.json',
  'migrations/production/20261112140500_r59_production_schema.sql',
  'migrations/production/20261112140500_r59_production_schema_rollback.sql',
  'scripts/apply-production-schema-bundle.mjs',
  'scripts/artifact-publisher-production.mjs',
  'scripts/artifact-publisher-production.test.mjs',
  'scripts/artifact-publisher-staging-16abbf4.mjs',
  'scripts/production-schema-postcheck.mjs',
  'scripts/production-schema-precheck.mjs',
]);

export function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function productionApproval(argv) {
  const index = argv.indexOf('--approve-production-site');
  if (index < 0 || !argv[index + 1]) throw fail('refusing_production_approval');
  return assertApprovedSite(argv[index + 1]);
}

export function assertApprovedSite(value) {
  if (value === STAGING_SITE_ID) throw fail('refusing_production_site');
  if (value !== PRODUCTION_SITE_ID) throw fail('refusing_production_site');
  return value;
}

const visitorGateSetting = 'sso' + '_login';

export function assertProductionApiPath(path) {
  const value = String(path || '');
  if (value.includes(STAGING_SITE_ID)) throw fail('refusing_production_site');
  if (value.toLowerCase().includes(visitorGateSetting)) throw fail('refusing_visitor_gate_change');
  if (/\/env(?:\/|$|\?)/.test(value)) throw fail('refusing_env_write');
  const site = `/api/v1/sites/${PRODUCTION_SITE_ID}`;
  const pathOnly = value.split('?')[0];
  const deploy = /^\/api\/v1\/deploys\/[0-9a-f]{24}(?:\/lock|\/files\/.+|\/functions\/[^/]+)$/.test(pathOnly);
  if (!(value === site || value.startsWith(`${site}/`) || value.startsWith(`${site}?`) || deploy)) {
    throw fail('refusing_site_mismatch');
  }
  return value;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw fail('git_failed');
  return result.stdout.trim();
}

export function packageCommitAllowed(head = git(['rev-parse', 'HEAD'])) {
  if (head === PINNED_COMMIT) return true;
  const names = git(['diff', '--name-only', PINNED_COMMIT, head]).split('\n').filter(Boolean);
  return names.length > 0 && names.every((name) => publisherFiles.has(name));
}

function requirePackage() {
  const head = git(['rev-parse', 'HEAD']);
  if (!packageCommitAllowed(head)) throw fail('refusing_unpinned_commit');
  if (git(['status', '--porcelain'])) throw fail('refusing_dirty_tree');
  const manifestPath = resolve(packageDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw fail('package_not_built');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.commit !== PINNED_COMMIT && manifest.commit !== head) throw fail('package_commit_mismatch');
  if (createHash('sha256').update(readFileSync(resolve(packageDir, 'manifest.json'))).digest('hex') !== manifest.manifestSha256) {
    throw fail('manifest_digest_mismatch');
  }
  const fileMap = includeNetlifyToml(JSON.parse(readFileSync(resolve(packageDir, 'file-list.json'), 'utf8')), resolve(root, 'netlify.toml'));
  const checksum = packageChecksum(hashTree(resolve(packageDir, 'publish')), readFileSync(resolve(root, 'netlify.toml')));
  if (checksum !== manifest.packageSha256) throw fail('package_checksum_mismatch');
  return { head, manifest, fileMap, checksum };
}

function journalBase(pkg) {
  return {
    state: 'attempt-prepared',
    siteId: PRODUCTION_SITE_ID,
    pinnedCommit: PINNED_COMMIT,
    packageCommit: pkg.head,
    packageSha256: pkg.checksum,
    changesVisitorGate: false,
    writesEnv: false,
    createdAt: new Date().toISOString(),
  };
}

function writeJournal(name, body) {
  mkdirSync(journalDir, { recursive: true });
  const path = resolve(journalDir, name);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

function responseText(response) {
  return response?.body?.toString?.('utf8') || '';
}

function responseJson(response, code) {
  if (!response || response.status !== 200) throw fail(code);
  try { return JSON.parse(responseText(response)); }
  catch { throw fail(code); }
}

export async function productionRequest(method, path, token, body, contentType, retryCount = 0) {
  assertProductionApiPath(path);
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = {
    ...functionUploadHeaders(token, retryCount),
    ...(payload ? { 'content-type': contentType || 'application/json', 'content-length': payload.length } : {}),
  };
  return new Promise((resolvePromise, reject) => {
    const req = https.request({
      host: API_HOST, method, path, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function pollProductionDeploy(request, token, deployId, ready, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await request('GET', `/api/v1/sites/${PRODUCTION_SITE_ID}/deploys/${deployId}`, token);
    if (response.status === 401 || response.status === 403) throw fail('auth_required');
    if (response.status !== 200) throw fail('deploy_poll_failed');
    last = JSON.parse(responseText(response));
    if (last.site_id && last.site_id !== PRODUCTION_SITE_ID) throw fail('refusing_site_mismatch');
    if (last.state === 'error' || last.state === 'canceled') throw fail('deploy_not_ready');
    const blocker = publishBlocker(last);
    if (blocker === 'failed') throw fail('deploy_not_ready');
    if (ready && blocker === 'context') throw fail('refusing_deploy_context');
    if (ready && blocker === 'ok') return last;
    if (!ready && diffReady(last)) return last;
    await sleep(2000);
  }
  throw fail('deploy_poll_timeout');
}

async function uploadOutstanding(request, token, deployId, diff, fileMap, functionMap, journal, sleep) {
  journal.uploads = journal.uploads || [];
  const put = async (branch, sha, requestPath, bytes, contentType) => {
    let retryCount = 0;
    for (;;) {
      const uploaded = await request(requestPath.method, requestPath.path, token, bytes, contentType, retryCount);
      const kind = classifyUploadResponse(uploaded.status, responseText(uploaded));
      journal.uploads.push({ branch, sha, path: requestPath.path.split('?')[0], status: uploaded.status, bytes: bytes.length, retryCount });
      if (kind === 'ok') return;
      if ((kind === 'wait-prepared' || kind === 'retry-same-token') && retryCount < 3) {
        if (kind === 'wait-prepared') {
          const settled = await pollProductionDeploy(request, token, deployId, false, sleep);
          if (!diffReady(settled)) throw fail('deploy_not_prepared');
        }
        retryCount += 1;
        continue;
      }
      if (kind === 'auth_required') throw fail('auth_required');
      throw fail(kind === 'wait-prepared' ? 'deploy_not_prepared' : 'deploy_upload_failed');
    }
  };
  for (const sha of diff.required || []) {
    const entries = fileMap.byHash[sha];
    if (!entries?.length) throw fail('deploy_upload_failed');
    for (const entry of entries) {
      const bytes = readFileSync(entry.path);
      await put('files', sha, { method: 'PUT', path: `${fileUploadPath(deployId, entry.rel)}?size=${bytes.length}` }, bytes, 'application/octet-stream');
    }
  }
  for (const sha of functionShasToUpload(diff.required_functions, functionMap.byHash)) {
    const entries = functionMap.byHash[sha];
    if (!entries?.length) throw fail('deploy_upload_failed');
    for (const fn of entries) {
      const bytes = readFileSync(fn.path);
      await put('functions', sha, { method: 'PUT', path: functionUploadQuery(deployId, fn, bytes.length) }, bytes, 'application/zip');
    }
  }
}

export async function confirmProductionPublished(request, token, deployId) {
  if (!/^[0-9a-f]{24}$/.test(deployId)) throw fail('invalid_deploy_id');
  const restored = await request('POST', `/api/v1/sites/${PRODUCTION_SITE_ID}/deploys/${deployId}/restore`, token, '{}');
  if (!restored || restored.status < 200 || restored.status >= 300) throw fail('deploy_publish_failed');
  const siteResponse = await request('GET', `/api/v1/sites/${PRODUCTION_SITE_ID}`, token);
  const site = responseJson(siteResponse, 'deploy_publish_failed');
  if (site.id !== PRODUCTION_SITE_ID) throw fail('refusing_site_mismatch');
  const published = site.published_deploy || {};
  if (published.id !== deployId) throw fail('deploy_publish_unconfirmed');
  if (published.context !== 'production') throw fail('refusing_deploy_context');
  return { published: true, publishedDeployId: published.id, context: published.context };
}

function defaultProbe(deploy) {
  const raw = deploy?.ssl_url || deploy?.deploy_ssl_url || deploy?.url || '';
  let host;
  try { host = new URL(raw).host; }
  catch { throw fail('probe_url_missing'); }
  const body = Buffer.from('{}');
  return new Promise((resolvePromise, reject) => {
    const req = https.request({
      host, method: 'POST', path: '/api/auth/login',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'content-length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({
        status: res.statusCode || 0,
        contentType: String(res.headers['content-type'] || ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function uploadProductionDeploy({
  request, token, fileMap, functionMap, journal, sleep, probe = defaultProbe,
}) {
  if (!fileMap?.files?.['/netlify.toml'] || !apiRoutesOk(functionMap)) throw fail('refusing_missing_routes');
  journal.writesEnv = false;
  journal.changesVisitorGate = false;
  const site = responseJson(await request('GET', `/api/v1/sites/${PRODUCTION_SITE_ID}`, token), 'site_lookup_failed');
  if (site.id !== PRODUCTION_SITE_ID) throw fail('refusing_site_mismatch');
  const live = site.published_deploy || {};
  journal.rollbackDeployId = live.id || null;
  if (needsPublishingLock(live)) {
    const locked = await request('POST', `/api/v1/deploys/${live.id}/lock`, token, '{}');
    if (!locked || locked.status < 200 || locked.status >= 300) throw fail('publishing_lock_failed');
    journal.publishingLocked = true;
    journal.lockedDeployId = live.id;
  }
  const createBody = JSON.stringify(productionDeployBody({
    files: fileMap.files,
    functions: functionMap.functions,
    functionsConfig: functionMap.functionsConfig,
    schedules: functionMap.schedules,
  }));
  const created = await request('POST', `/api/v1/sites/${PRODUCTION_SITE_ID}/deploys?title=${encodeURIComponent(`oi production ${PINNED_COMMIT.slice(0, 7)}`)}`, token, createBody);
  if (!created || created.status === 401 || created.status === 403) throw fail('auth_required');
  if (!created || (created.status !== 200 && created.status !== 201)) throw fail('deploy_create_failed');
  const deploy = JSON.parse(responseText(created));
  if (!/^[0-9a-f]{24}$/.test(deploy.id || '')) throw fail('deploy_create_failed');
  if (deploy.site_id && deploy.site_id !== PRODUCTION_SITE_ID) throw fail('refusing_site_mismatch');
  if (deploy.context && deploy.context !== 'production') throw fail('refusing_deploy_context');
  journal.deployId = deploy.id;
  let prepared = diffReady(deploy) ? deploy : await pollProductionDeploy(request, token, deploy.id, false, sleep);
  if (!publishWithoutUpload(prepared)) {
    await uploadOutstanding(request, token, deploy.id, prepared, fileMap, functionMap, journal, sleep);
    prepared = await pollProductionDeploy(request, token, deploy.id, true, sleep);
  } else if (prepared.state !== 'ready') {
    prepared = await pollProductionDeploy(request, token, deploy.id, true, sleep);
  }
  if (publishBlocker(prepared) !== 'ok') throw fail('deploy_not_ready');
  const gate = assertPublishableDeploy(prepared);
  const probed = await probe(prepared);
  journal.probeStatus = probed?.status ?? null;
  journal.privacyGate = isPrivacyGate(probed);
  if (!loginProbeReached(probed)) throw fail('refusing_visitor_gate');
  journal.context = gate.context;
  journal.routes = gate.apiRoutes;
  const confirmed = await confirmProductionPublished(request, token, deploy.id);
  journal.state = 'published';
  journal.publishedDeployId = confirmed.publishedDeployId;
  return journal;
}

export function uploadCheckReport(fileMap, functionMap) {
  const missing = checkLocalLookups(fileMap, functionMap);
  const zipProblems = [];
  for (const [name, sha] of Object.entries(functionMap?.functions || {})) {
    const entry = (functionMap.byHash?.[sha] || []).find((item) => item.name === name);
    if (!entry) continue;
    const bytes = readFileSync(entry.path);
    let names = [];
    try { names = listZipEntryNames(bytes); }
    catch (error) { zipProblems.push(`${name} zip could not be listed: ${error.message}`); }
    zipProblems.push(...functionZipProblems(name, bytes.length, names));
    if (name === 'api') {
      try {
        const unzipped = zipUnzippedBytes(bytes);
        if (unzipped > API_ZIP_MAX_UNZIPPED_BYTES) zipProblems.push(`api zip unpacks to ${unzipped} bytes, over ${API_ZIP_MAX_UNZIPPED_BYTES}`);
      } catch (error) { zipProblems.push(`api zip size could not be measured: ${error.message}`); }
      zipProblems.push(...eagerNativeProblemsForZip(bytes, names));
    }
  }
  const routesOk = apiRoutesOk(functionMap);
  const apiInvocationMode = functionMap?.functionsConfig?.api?.invocation_mode || null;
  const invocationOk = apiInvocationMode === 'stream';
  const netlifyToml = Boolean(fileMap?.files?.['/netlify.toml']);
  const productionContext = productionDeployBody({
    files: fileMap.files, functions: functionMap.functions, functionsConfig: functionMap.functionsConfig,
  }).draft === false;
  const problems = [...missing.map((item) => `missing:${item.branch}:${item.missingHash}`), ...zipProblems];
  if (!routesOk) problems.push('missing_api_routes');
  if (!invocationOk) problems.push('invocation_not_stream');
  if (!netlifyToml) problems.push('missing_netlify_toml');
  if (!productionContext) problems.push('draft_context');
  return {
    ok: problems.length === 0,
    problems,
    missing,
    zipProblems,
    routesOk,
    invocationOk,
    netlifyToml,
    draft: false,
    context: 'production',
    writesEnv: false,
    changesVisitorGate: false,
  };
}

async function main() {
  const site = productionApproval(process.argv);
  const publish = process.argv.includes('--publish-approved');
  const uploadCheck = process.argv.includes('--upload-check');
  const diagnose = process.argv.includes('--diagnose');
  const checkDeploy = process.argv.includes('--check-deploy');
  if ([publish, uploadCheck, diagnose, checkDeploy].filter(Boolean).length > 1) throw fail('refusing_mixed_commands');
  const pkg = requirePackage();
  if (uploadCheck) {
    const functionMap = await bundleFunctions(DEFAULT_NETLIFY_CLI_DIR);
    const report = uploadCheckReport(deployFiles(), functionMap);
    const path = writeJournal('upload-check.json', { ...journalBase(pkg), ...report, state: report.ok ? 'upload-check-ok' : 'upload-check-failed' });
    if (!report.ok) throw fail('upload_check_failed');
    console.log(JSON.stringify({ uploadCheck: path, siteId: site }));
    return;
  }
  if (diagnose || checkDeploy) {
    const token = await authorize(DEFAULT_NETLIFY_CLI_DIR);
    const response = await productionRequest('GET', `/api/v1/sites/${PRODUCTION_SITE_ID}`, token);
    const lookedUp = responseJson(response, 'site_lookup_failed');
    if (lookedUp.id !== PRODUCTION_SITE_ID) throw fail('refusing_site_mismatch');
    const path = writeJournal(diagnose ? 'diagnose.json' : 'check-deploy.json', {
      ...journalBase(pkg),
      state: diagnose ? 'diagnose' : 'check-deploy',
      liveDeployId: lookedUp.published_deploy?.id || null,
    });
    console.log(JSON.stringify({ journal: path, siteId: site }));
    return;
  }
  const body = journalBase(pkg);
  if (!publish) {
    const path = writeJournal('publication-dry-run.json', body);
    console.log(JSON.stringify({ dryRun: path, siteId: site, pinnedCommit: PINNED_COMMIT }));
    return;
  }
  const token = await authorize(DEFAULT_NETLIFY_CLI_DIR);
  const functionMap = await bundleFunctions(DEFAULT_NETLIFY_CLI_DIR);
  const journal = await uploadProductionDeploy({
    request: productionRequest,
    token,
    fileMap: deployFiles(),
    functionMap,
    journal: body,
  });
  const path = writeJournal('publication.json', journal);
  console.log(JSON.stringify({ published: path, deployId: journal.publishedDeployId, siteId: site }));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error.code || error.message);
    process.exit(1);
  });
}
