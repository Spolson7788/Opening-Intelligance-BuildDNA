import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSite, assertStagingApiPath, PRODUCTION_SITE_ID, STAGING_SITE_ID, STAGING_SITE_NAME, STAGING_URL, PINNED_COMMIT } from './artifact-publisher-staging-16abbf4.mjs';

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
