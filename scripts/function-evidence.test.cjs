const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createEvidence} = require('../plugins/function-evidence/evidence.cjs');
function fixture(t) {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'oi-function-evidence-'));
  t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
  for(const name of ['api','photo-deletion-retry'])fs.writeFileSync(path.join(d,name+'.zip'),Buffer.from([80,75,3,4,1,2,3,4]));
  return d;
}
const id={commit:'a'.repeat(40),deployId:'b'.repeat(24),context:'deploy-preview'};
test('hashes both package bytes and detects changed content',t=>{
  const d=fixture(t), before=createEvidence(d,id);
  const changed=Buffer.from([80,75,3,4,9,8,7,6]);fs.writeFileSync(path.join(d,'api.zip'),changed);
  const after=createEvidence(d,id);
  assert.notEqual(after.artifacts.api.sha256,before.artifacts.api.sha256);
  assert.equal(after.artifacts.api.sha256,createHash('sha256').update(changed).digest('hex'));
  assert.equal(after.artifacts['photo-deletion-retry'].sha256,before.artifacts['photo-deletion-retry'].sha256);
});
test('missing worker package fails',t=>{const d=fixture(t);fs.unlinkSync(path.join(d,'photo-deletion-retry.zip'));assert.throws(()=>createEvidence(d,id));});
test('source file masquerading as package fails',t=>{const d=fixture(t);fs.writeFileSync(path.join(d,'api.zip'),'source only');assert.throws(()=>createEvidence(d,id),/Invalid function ZIP/);});
test('unbound identity fails',t=>assert.throws(()=>createEvidence(fixture(t),{...id,commit:''}),/Missing build identity/));
test('symlink package fails',t=>{const d=fixture(t);fs.unlinkSync(path.join(d,'api.zip'));fs.symlinkSync(path.join(d,'photo-deletion-retry.zip'),path.join(d,'api.zip'));assert.throws(()=>createEvidence(d,id),/Expected packaged/);});
