import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertIsolatedReleaseContext} from '../isolated-release-context.mjs';
import {assertReferenceStagingDatabase,requireReferenceStagingRuntime,REFERENCE_STAGING_PROJECT_REF} from './preview-context.mjs';
const ref=REFERENCE_STAGING_PROJECT_REF, other='b'.repeat(20);
const legacy={NETLIFY:'true',SITE_ID:'80fbbee8-b9d3-4b16-b93f-d2d8396591ec',CONTEXT:'production',BRANCH:'release/connected-candidate'};
const preview={...legacy,CONTEXT:'deploy-preview',HEAD:'feat/reference-evidence-os6',OI_REFERENCE_STAGING_PROJECT_REF:ref,DATABASE_URL:`postgres://role:fixture@db.${ref}.supabase.co/postgres`};
test('frozen release build remains allowed',()=>assert.doesNotThrow(()=>assertIsolatedReleaseContext(legacy)));
test('designated preview accepts only matching staging project',()=>{assert.doesNotThrow(()=>assertIsolatedReleaseContext(preview));assert.throws(()=>assertIsolatedReleaseContext({...preview,DATABASE_URL:`postgres://role:fixture@db.${other}.supabase.co/postgres`}));});
test('unknown site, branch and unconfigured preview are refused',()=>{for(const patch of [{SITE_ID:'wrong'},{HEAD:'unrelated'},{OI_REFERENCE_STAGING_PROJECT_REF:undefined}])assert.throws(()=>assertIsolatedReleaseContext({...preview,...patch}));});
test('pooler project must match the selected staging project',()=>{assert.doesNotThrow(()=>assertReferenceStagingDatabase({...preview,DATABASE_URL:`postgres://role.${ref}:fixture@aws-0-us-west-1.pooler.supabase.com/postgres`}));assert.throws(()=>assertReferenceStagingDatabase({...preview,DATABASE_URL:`postgres://role.${other}:fixture@aws-0-us-west-1.pooler.supabase.com/postgres`}));});
test('runtime preview refuses missing or mismatched connection before writes',()=>{const c={deploy:{context:'deploy-preview'}};assert.throws(()=>requireReferenceStagingRuntime(c,undefined,()=>ref));assert.throws(()=>requireReferenceStagingRuntime(c,`postgres://role:fixture@db.${other}.supabase.co/postgres`,()=>ref));assert.doesNotThrow(()=>requireReferenceStagingRuntime(c,preview.DATABASE_URL,()=>ref));assert.doesNotThrow(()=>requireReferenceStagingRuntime({deploy:{context:'production'}},undefined,()=>undefined));});
test('connection errors never expose credentials',()=>{const password='sensitive-test-string';try {assertReferenceStagingDatabase({...preview,DATABASE_URL:`postgres://role:${password}@db.${other}.supabase.co/postgres`});assert.fail('Must reject');}catch(e){assert.ok(!e.message.includes(password));}});

test('preview build accepts Functions-only credentials without requiring their build exposure',()=>{
  const {DATABASE_URL,...buildEnv}=preview;
  assert.doesNotThrow(()=>assertIsolatedReleaseContext(buildEnv));
});
test('build and runtime refuse a different designated project even if its URL matches',()=>{
  const wrong={...preview,OI_REFERENCE_STAGING_PROJECT_REF:other,DATABASE_URL:`postgres://role:fixture@db.${other}.supabase.co/postgres`};
  assert.throws(()=>assertIsolatedReleaseContext(wrong));
  assert.throws(()=>requireReferenceStagingRuntime({deploy:{context:'deploy-preview'}},wrong.DATABASE_URL,()=>other));
});
test('both preview contexts require an actual matching runtime connection',()=>{
  for(const context of ['deploy-preview','branch-deploy']){
    assert.throws(()=>requireReferenceStagingRuntime({deploy:{context}},undefined,()=>ref));
    assert.throws(()=>requireReferenceStagingRuntime({deploy:{context}},`postgres://role:fixture@db.${other}.supabase.co/postgres`,()=>ref));
    assert.doesNotThrow(()=>requireReferenceStagingRuntime({deploy:{context}},preview.DATABASE_URL,()=>ref));
  }
});
