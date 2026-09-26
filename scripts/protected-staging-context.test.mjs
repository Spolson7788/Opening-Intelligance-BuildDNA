import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProtectedStagingContext } from './protected-staging-context.mjs';

const preview = {NETLIFY:'true', SITE_ID:'6430c57d-8a98-43bc-ba25-94007dd244f2', CONTEXT:'deploy-preview', BRANCH:'pull/9/head', HEAD:'feat/field-territory-integration', REVIEW_ID:'9'};
test('permits exactly the reviewed protected preview and existing staging branch', () => {
  assert.doesNotThrow(() => assertProtectedStagingContext(preview));
  assert.doesNotThrow(() => assertProtectedStagingContext({...preview, CONTEXT:'branch-deploy', BRANCH:'pr2-staging', REVIEW_ID:undefined}));
});
for (const [name, override] of Object.entries({
  production: {CONTEXT:'production'},
  anotherSite: {SITE_ID:'other'},
  anotherPullRequest: {REVIEW_ID:'10'},
  missingPullRequest: {REVIEW_ID:undefined},
  anotherBranch: {HEAD:'main'},
  unapprovedBranchDeploy: {CONTEXT:'branch-deploy'},
})) test(`rejects ${name}`, () => assert.throws(() => assertProtectedStagingContext({...preview,...override})));
test('local build does not require hosted metadata', () => assert.doesNotThrow(() => assertProtectedStagingContext({})));
