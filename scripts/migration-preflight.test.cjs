const {test} = require('node:test');
const assert = require('node:assert/strict');
const {assertMigrationBaseline} = require('./migration-preflight.cjs');
test('existing untracked schema fails before any mutation', async () => {
  let calls=0;
  await assert.rejects(assertMigrationBaseline({query:async sql=>{
    calls++; assert.match(sql,/^SELECT/);
    return {rows:[{app_ledger:false,existing_tables:true}]};
  }}),/requires reconciliation/);
  assert.equal(calls,1);
});
test('fresh database and established ledger pass', async () => {
  for (const state of [{app_ledger:false,existing_tables:false},{app_ledger:true,existing_tables:true}]) {
    await assertMigrationBaseline({query:async()=>({rows:[state]})});
  }
});
test('missing inventory or failed inventory fails closed', async () => {
  await assert.rejects(assertMigrationBaseline({query:async()=>({rows:[]})}));
  await assert.rejects(assertMigrationBaseline({query:async()=>{throw Error('unavailable')}}),/unavailable/);
});
