const {test}=require('node:test');
const assert=require('node:assert/strict');
const {planLegacy}=require('./legacy-plan.cjs');
const f=[{id:'a',name:'Same name'},{id:'b',name:'Same name'}];
const row=(id,facility_id,component_class='DOOR_CLOSER')=>({id,facility_id,opening_no:'101',component_class,condition:'Good',manufacturer:'Example',model:'123',notes:'preserve exactly'});
test('groups physical opening, never same-name facilities; preserves every source',()=>{
 const rows=[row('1','a'),row('2','a','DOOR'),row('3','b')];
 const p=planLegacy({facilities:f,openings:rows});
 assert.deepEqual(p.counts,{facilities:2,legacy_rows:3,physical_openings:2,hardware:2,unresolved_structure:1});
 assert.deepEqual(p.legacy_rows,rows);
 assert.equal(p.executable,false);
});
test('ids and complete plan stable across input order and retry',()=>{
 const rows=[row('1','a'),row('2','a'),row('3','b')];
 assert.deepEqual(planLegacy({facilities:f,openings:rows}),planLegacy({facilities:[...f].reverse(),openings:[...rows].reverse()}));
});
test('does not invent inspection, manufacturer approval, leaf assignment or geography',()=>{
 const p=planLegacy({facilities:f,openings:[row('1','a')]});
 const o=p.openings[0],c=o.components[0];
 assert.equal(o.configuration,null); assert.equal(o.completion_state,'draft');
 assert.equal(c.condition,'unverified'); assert.equal(c.identity_status,'unresolved');
 assert.equal(c.review_state,'pending'); assert.equal(c.mounting_scope,null);
 assert.equal(p.facilities[0].organization_id,null);assert.equal(p.facilities[0].state,null);
});
test('rejects duplicate identities, dangling references and missing opening numbers',()=>{
 for(const snapshot of [
  {facilities:[...f,f[0]],openings:[]},
  {facilities:f,openings:[row('1','a'),row('1','b')]},
  {facilities:f,openings:[row('1','missing')]},
  {facilities:f,openings:[{...row('1','a'),opening_no:''}]}
 ]) assert.throws(()=>planLegacy(snapshot));
});
test('unknown classes retained for review and input is not mutated',()=>{
 const s={facilities:f,openings:[row('1','a','UNKNOWN')]}, before=structuredClone(s);
 const p=planLegacy(s);assert.deepEqual(s,before);
 assert.equal(p.counts.unresolved_structure,1);assert.equal(p.legacy_rows[0].component_class,'UNKNOWN');
});
