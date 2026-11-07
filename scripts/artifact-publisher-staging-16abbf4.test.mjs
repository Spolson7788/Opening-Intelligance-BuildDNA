import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRoutesOk, assertSite, assertStagingApiPath, checkLocalLookups, diffReady, fileDigestKey, fileUploadPath, functionConfigFromBuild, publishReadyDeploy, publishWithoutUpload, readyPublishSteps, selectUploadSnapshot, PRODUCTION_SITE_ID, STAGING_SITE_ID, STAGING_SITE_NAME, STAGING_URL, PINNED_COMMIT } from './artifact-publisher-staging-16abbf4.mjs';

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
  assert.equal(diffReady({ state: 'uploading', required: [], required_functions: [] }), false);
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
    published_deploy: { id: deployId },
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
  assert.deepEqual(result, { published: true, publishedDeployId: deployId });
  await assert.rejects(() => publishReadyDeploy(async (method) => {
    if (method === 'POST') return { status: 200, body: Buffer.from('{}') };
    return { status: 200, body: Buffer.from(JSON.stringify({ ...site, published_deploy: { id: '6aef9b65877e6e067c751d5b' } })) };
  }, deployId), /deploy_publish_unconfirmed/);
});
