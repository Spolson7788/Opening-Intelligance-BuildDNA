import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { apiFunctionView, apiRoutesOk, assertPublishableDeploy, assertSite, assertStagingApiPath, checkLocalLookups, classifyUploadResponse, compareDeploySnapshots, diffReady, fileDigestKey, fileUploadPath, functionConfigFromBuild, functionInvocationMode, functionUploadHeaders, functionUploadQuery, functionsZipConfig, includeNetlifyToml, functionShasToUpload, invocationStampComment, loginProbeReached, needsPublishingLock, productionDeployBody, publishBlocker, publishReadyDeploy, publishWithoutUpload, readyPublishSteps, rollbackTarget, scrubDeployValue, selectPublishSnapshot, selectUploadSnapshot, snapshotFromResponses, compareFunctionLists, functionsFromDeploy, stageFunctionSources, PRODUCTION_SITE_ID, STAGING_SITE_ID, STAGING_SITE_NAME, STAGING_URL, PINNED_COMMIT } from './artifact-publisher-staging-16abbf4.mjs';

test('diagnose compares function metadata without keeping secrets', () => {
  const knownGood = functionsFromDeploy({ available_functions: [{ n: 'api', d: 'sha-good', runtime: 'nodejs22.x', im: 'stream', ro: [], a: 100 }] });
  const candidate = functionsFromDeploy({
    available_functions: [{ n: 'api', d: 'sha-bad', runtime: 'nodejs22.x', im: 'stream', ro: [], a: 528289, authorization: 'Bearer secret-token' }],
    functions_config: { api: { routes: [{ pattern: '/health' }, { pattern: '/api/*' }] } },
  });
  const differences = compareFunctionLists(knownGood, candidate);
  const api = differences.find((item) => item.name === 'api');
  assert.equal(api.fields.sha.knownGood, 'sha-good');
  assert.equal(api.fields.size.candidate, 528289);
  assert.deepEqual(candidate[0].routes, ['/health', '/api/*']);
  assert.equal(JSON.stringify(differences).includes('secret-token'), false);
});

test('staging site is the only accepted target', () => {
  assert.deepEqual(assertSite({ id: STAGING_SITE_ID, name: STAGING_SITE_NAME, url: STAGING_URL }), {
    id: STAGING_SITE_ID, name: STAGING_SITE_NAME, url: STAGING_URL,
  });
});

test('production and any other site are refused', () => {
  assert.throws(() => assertSite({ id: PRODUCTION_SITE_ID, name: 'oi-production', url: 'https://oi-production.netlify.app' }), /refusing_production/);
  assert.throws(() => assertSite({ id: '80fbbee8-b9d3-4b16-b93f-d2d8396591ec', name: 'oi-connected-release-candidate', url: 'https://oi-connected-release-candidate.netlify.app' }), /refusing_site_mismatch/);
  assert.equal(PINNED_COMMIT, '16abbf48967b17d6cddf8acfcf77eecbc8d2f2a5');
  assert.equal(assertStagingApiPath(`/api/v1/sites/${STAGING_SITE_ID}`), `/api/v1/sites/${STAGING_SITE_ID}`);
  assert.throws(() => assertStagingApiPath(`/api/v1/sites/${PRODUCTION_SITE_ID}`), /refusing_production/);
  assert.throws(() => assertStagingApiPath('/api/v1/deploys/other/files/index.html', 'ours'), /refusing_site_mismatch/);
});

test('required file sha1 and function sha256 both resolve', () => {
  const fileSha = 'a'.repeat(40);
  const functionSha = 'b'.repeat(64);
  const fileMap = { files: { 'index.html': fileSha }, byHash: { [fileSha]: [{ rel: 'index.html', path: 'index.html' }] } };
  const functionMap = { functions: { api: functionSha }, byHash: { [functionSha]: [{ name: 'api', path: 'api.zip', runtime: 'js' }] } };
  assert.deepEqual(checkLocalLookups(fileMap, functionMap), []);
  assert.equal(fileMap.byHash[fileSha][0].rel, 'index.html');
  assert.equal(functionMap.byHash[functionSha][0].name, 'api');
  assert.equal(fileDigestKey('index.html'), '/index.html');
  assert.equal(fileDigestKey('/field/index.html'), '/field/index.html');
  assert.equal(fileUploadPath('abc', '/index.html'), '/api/v1/deploys/abc/files/index.html');
  assert.equal(diffReady({ state: 'uploading', required: [], required_functions: [] }), true);
  const preparing = { state: 'preparing', required: [], required_functions: ['f1d3799c'] };
  assert.equal(diffReady(preparing), false);
  assert.equal(selectUploadSnapshot([preparing, { state: 'prepared', required: [], required_functions: ['f1d3799c'] }]).state, 'prepared');
  const prepared = { state: 'prepared', required: ['646641cc', '4b841fe6', '34618751', '5ae24228'], required_functions: [] };
  assert.equal(diffReady(prepared), true);
  assert.equal(selectUploadSnapshot([{ state: 'preparing', required: [], required_functions: [] }, prepared]), prepared);
  const deduped = { state: 'ready', required: [], required_functions: [] };
  assert.equal(publishWithoutUpload(deduped), true);
  assert.equal(publishWithoutUpload({ state: 'prepared', required: [], required_functions: [] }), true);
  assert.equal(publishWithoutUpload(prepared), false);
  assert.equal(selectUploadSnapshot([{ state: 'preparing', required: [] }, deduped]), deduped);
  assert.deepEqual(readyPublishSteps(deduped), ['restore', 'confirm-published']);
  assert.deepEqual(readyPublishSteps(prepared), ['upload', 'wait-ready', 'restore', 'confirm-published']);
  assert.deepEqual(readyPublishSteps(preparing), ['wait-prepared', 'upload', 'wait-ready', 'restore', 'confirm-published']);
  const api = functionConfigFromBuild({ name: 'api', routes: ['/health', '/api/*'], displayName: 'API', generator: '@netlify/functions', schedule: '0 0 * * *' });
  assert.deepEqual(api.routes, ['/health', '/api/*']);
  assert.equal(api.display_name, 'API');
  assert.equal(apiRoutesOk({ functionsConfig: { api } }), true);
  assert.equal(apiRoutesOk({ functionsConfig: { api: { routes: ['/health'] } } }), false);
  const zisiRoutes = [
    { pattern: '/health', literal: '/health' },
    { pattern: '/api/*', expression: '^\\/api(?:\\/(.*))\\/?$' },
  ];
  const zisi = functionConfigFromBuild({ name: 'api', routes: zisiRoutes });
  assert.deepEqual(zisi.routes, zisiRoutes);
  assert.equal(apiRoutesOk({ functionsConfig: { api: zisi } }), true);
  assert.equal(fileMap.byHash['index.html'], undefined);
  assert.equal(functionMap.byHash.api, undefined);
  const missing = checkLocalLookups(
    { files: { 'index.html': fileSha }, byHash: {} },
    { functions: { api: functionSha }, byHash: {} },
  );
  assert.deepEqual(missing, [
    { branch: 'files', missingHash: fileSha },
    { branch: 'functions', missingHash: functionSha },
  ]);
});

test('a ready deploy is restored once and confirmed as the published deploy', async () => {
  const deployId = '6aefa304e95393802c4d7b16';
  const calls = [];
  const site = {
    id: STAGING_SITE_ID,
    name: STAGING_SITE_NAME,
    ssl_url: STAGING_URL,
    published_deploy: { id: deployId, context: 'production' },
  };
  const result = await publishReadyDeploy(async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === 'POST') return { status: 200, body: Buffer.from('{}') };
    return { status: 200, body: Buffer.from(JSON.stringify(site)) };
  }, deployId);
  assert.deepEqual(calls, [
    `POST /api/v1/sites/${STAGING_SITE_ID}/deploys/${deployId}/restore`,
    `GET /api/v1/sites/${STAGING_SITE_ID}`,
  ]);
  assert.deepEqual(result, { published: true, publishedDeployId: deployId, context: 'production' });
  await assert.rejects(() => publishReadyDeploy(async (method) => {
    if (method === 'POST') return { status: 200, body: Buffer.from('{}') };
    return { status: 200, body: Buffer.from(JSON.stringify({ ...site, published_deploy: { id: '6aef9b65877e6e067c751d5b' } })) };
  }, deployId), /deploy_publish_unconfirmed/);
  await assert.rejects(() => publishReadyDeploy(async (method) => {
    if (method === 'POST') return { status: 200, body: Buffer.from('{}') };
    return { status: 200, body: Buffer.from(JSON.stringify({ ...site, published_deploy: { id: deployId, context: 'deploy-preview' } })) };
  }, deployId), /refusing_deploy_context/);
});

test('a preparing deploy is not uploaded, and a function retry keeps the same token', () => {
  const body = "Access Denied: deploy must be in , not preparing / Access Denied: User does not have access / could not authenticate request";
  assert.equal(classifyUploadResponse(401, body), 'wait-prepared');
  assert.equal(classifyUploadResponse(401, 'Access Denied: User does not have access'), 'auth_required');
  assert.equal(classifyUploadResponse(500, 'could not authenticate request'), 'retry-same-token');
  const token = 'memory-token';
  assert.equal(functionUploadHeaders(token, 0).authorization, `Bearer ${token}`);
  assert.equal(functionUploadHeaders(token, 0)['x-nf-retry-count'], undefined);
  assert.equal(functionUploadHeaders(token, 1).authorization, `Bearer ${token}`);
  assert.equal(functionUploadHeaders(token, 1)['x-nf-retry-count'], '1');
  const routes = [{ pattern: '/health', literal: '/health' }, { pattern: '/api/*', expression: '^\\/api' }];
  const uploading = { state: 'uploading', context: 'production', required_functions: ['f1d3799c'] };
  const processing = { state: 'processing', context: 'production', required: [], required_functions: [] };
  const readyBare = { state: 'ready', context: 'production', required: [], required_functions: [], available_functions: [{ n: 'api', d: 'f1d3799c' }] };
  const readyRouted = { state: 'ready', context: 'production', available_functions: [{ n: 'api', d: 'f1d3799c', ro: routes }] };
  assert.equal(publishBlocker(uploading), 'wait');
  assert.equal(publishBlocker(processing), 'wait');
  assert.equal(publishBlocker(readyBare), 'invocation');
  assert.equal(publishBlocker({ ...readyRouted, available_functions: [{ n: 'api', im: 'stream', ro: routes }] }), 'ok');
  assert.equal(selectPublishSnapshot([uploading, processing, readyBare]), null);
  assert.equal(loginProbeReached(404), false);
  assert.equal(loginProbeReached(400), true);
  assert.equal(loginProbeReached({ status: 401, contentType: 'text/html', body: '<!doctype html><html>Login</html>' }), false);
  assert.equal(rollbackTarget().rollbackDeployId, '6aef3f786cc2af03c2ef1cd0');
  assert.equal(needsPublishingLock({ id: '6aef3f786cc2af03c2ef1cd0', locked: false }), true);
  assert.equal(needsPublishingLock({ id: '6aef3f786cc2af03c2ef1cd0', locked: true }), false);
  assert.deepEqual(functionShasToUpload([], { abc: [{ routes: [{ pattern: '/api/*' }] }] }), ['abc']);
  const knownGood = { state: 'ready', context: 'production', available_functions: [{ n: 'api', im: 'stream', ro: [] }] };
  assert.equal(publishBlocker(knownGood), 'ok');
  assert.equal(assertPublishableDeploy(knownGood).invocationMode, 'stream');
  assert.throws(() => assertPublishableDeploy(readyBare), /refusing_invocation_mode/);
  assert.deepEqual(apiFunctionView(readyRouted)[0].routes, ['/health', '/api/*']);
  const registered = { state: 'ready', context: 'production', available_functions: [{ n: 'api', d: 'sha', im: 'stream', ro: routes }] };
  assert.equal(apiFunctionView(registered)[0].invocationMode, 'stream');
  assert.equal(functionInvocationMode({ runtimeAPIVersion: 2 }), 'stream');
  assert.equal(functionInvocationMode({ runtimeAPIVersion: 2, invocationMode: 'background' }), 'background');
  assert.equal(
    functionUploadQuery('6aef3f786cc2af03c2ef1cd0', { name: 'api', runtime: 'nodejs22.x', routes: [{ pattern: '/api/*' }], timeout: 10 }, 528289),
    '/api/v1/deploys/6aef3f786cc2af03c2ef1cd0/functions/api?runtime=nodejs22.x&invocation_mode=stream&timeout=10&size=528289',
  );
  assert.equal(functionConfigFromBuild({ name: 'api', routes: [{ pattern: '/health' }, { pattern: '/api/*' }] }).invocation_mode, 'stream');
  const zipConfig = functionsZipConfig('[functions]\n  directory = "netlify/functions"\n  node_bundler = "esbuild"\n  external_node_modules = ["express"]\n');
  assert.equal(zipConfig['*'].nodeBundler, 'esbuild_zisi');
  assert.deepEqual(zipConfig['*'].externalNodeModules, ['express']);
});

test('the invocation stamp is appended only to a temp copy of the api function', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const original = readFileSync(resolve(repo, 'netlify/functions/api.ts'), 'utf8');
  const destination = resolve(repo, 'dist/function-src-test-stamp');
  rmSync(destination, { recursive: true, force: true });
  const functionsDir = stageFunctionSources(repo, 'stamp-a', destination);
  const staged = readFileSync(resolve(functionsDir, 'api.ts'), 'utf8');
  assert.equal(readFileSync(resolve(repo, 'netlify/functions/api.ts'), 'utf8'), original);
  assert.equal(staged, original + invocationStampComment('stamp-a'));
  assert.notEqual(staged, readFileSync(resolve(functionsDir, 'photo-deletion-retry.ts'), 'utf8'));
  rmSync(destination, { recursive: true, force: true });
  assert.equal(dirname(functionsDir).endsWith('netlify'), true);
});

test('compare deploys reports function routes, redirects, and env names without secrets', () => {
  const goodId = '6aef3f786cc2af03c2ef1cd0';
  const badId = '6aefa304e95393802c4d7b16';
  const base = { site_id: STAGING_SITE_ID, state: 'ready', context: 'production', framework: null };
  const good = snapshotFromResponses({
    id: goodId,
    deploy: {
      ...base,
      commit_ref: 'cli',
      available_functions: [{
        n: 'api', d: 'sha-good', runtime: 'js',
        ro: [{ pattern: '/health', literal: '/health' }, { pattern: '/api/*', expression: '^\\/api' }],
        bd: { runtimeAPIVersion: 2, env: { DATABASE_URL: 'postgres://secret', JWT_SECRET: 'nf_should_not_print' } },
      }],
      edge_functions: { deno: 'edge-good' },
      redirects: [{ from: '/api/*', to: '/.netlify/functions/api', status: 200 }],
    },
    fileList: [{ path: '/_redirects', sha: 'redirects-good', size: 80 }],
    listStatus: { files: 200 },
  });
  const bad = snapshotFromResponses({
    id: badId,
    deploy: {
      ...base,
      commit_ref: 'digest',
      functions_config: { api: { routes: [], build_data: { runtimeAPIVersion: 2, env: ['JWT_SECRET'] } } },
      available_functions: [{ n: 'api', d: 'sha-good', runtime: 'js', ro: [] }],
      edge_functions: null,
    },
    fileList: [{ path: '_redirects', sha: 'redirects-bad', size: 90 }],
    listStatus: { files: 200 },
  });
  const report = compareDeploySnapshots(good, bad);
  const api = report.differences.find((item) => item.kind === 'function' && item.name === 'api');
  assert.equal(api.change, 'different');
  assert.deepEqual(api.fields.routes.good.map((route) => route.pattern), ['/health', '/api/*']);
  assert.deepEqual(api.fields.routes.bad, []);
  assert.deepEqual(api.fields.build_data.good.envVarNames, ['DATABASE_URL', 'JWT_SECRET']);
  assert.ok(report.differences.some((item) => item.kind === 'redirects'));
  assert.ok(report.differences.some((item) => item.kind === 'files' && item.good._redirects.sha === 'redirects-good'));
  const text = JSON.stringify(report);
  assert.equal(text.includes('postgres://secret'), false);
  assert.equal(text.includes('nf_should_not_print'), false);
  assert.equal(scrubDeployValue({ authorization: 'Bearer abc', note: 'Bearer abc' }).note, '[redacted]');
});

test('a production deploy includes netlify.toml and refuses any other context', () => {
  const routes = [
    { pattern: '/health', literal: '/health' },
    { pattern: '/api/*', expression: '^\\/api(?:\\/(.*))\\/?$' },
  ];
  const files = includeNetlifyToml({ files: { '/index.html': 'abc' }, byHash: {} }, fileURLToPath(new URL('../netlify.toml', import.meta.url)));
  assert.equal(typeof files.files['/netlify.toml'], 'string');
  assert.equal(files.files['/netlify.toml'].length, 40);
  const body = productionDeployBody({
    files: files.files,
    functions: { api: 'f'.repeat(64) },
    functionsConfig: { api: { routes } },
  });
  assert.equal(body.draft, false);
  assert.equal(body.files['/netlify.toml'], files.files['/netlify.toml']);
  const ready = { context: 'production', available_functions: [{ n: 'api', im: 'stream', ro: [] }] };
  assert.equal(assertPublishableDeploy(ready).context, 'production');
  assert.throws(() => assertPublishableDeploy({ ...ready, context: 'deploy-preview' }), /refusing_deploy_context/);
  assert.throws(() => assertPublishableDeploy({ context: 'production', available_functions: [{ n: 'api', im: null, ro: [] }] }), /refusing_invocation_mode/);
});
