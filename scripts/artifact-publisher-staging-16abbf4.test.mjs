import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSite, assertStagingApiPath, checkLocalLookups, fileDigestKey, fileUploadPath, PRODUCTION_SITE_ID, STAGING_SITE_ID, STAGING_SITE_NAME, STAGING_URL, PINNED_COMMIT } from './artifact-publisher-staging-16abbf4.mjs';

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
