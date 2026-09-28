const assert=require('node:assert/strict');
exports.validateConfig=function(c){
 const releaseOrigin='https://6aba709e58e0e10008eb836e--oi-connected-release-candidate.netlify.app';
 if(c.origin===releaseOrigin){
  assert.equal(c.commit,'ab00a7bb04162008c2ebb1a1d58f8a8a75a63925','Release commit must match the pinned deployment');
  assert(c.accounts,'The isolated backend requires its own verified test accounts');
  for(const [key,role] of [['a','technician'],['b','technician'],['owner','admin']]){
   const account=c.accounts[key];assert(account);assert.equal(account.role,role);
   assert.match(account.email,/^[^@\s]+@[^@\s]+$/);
   for(const field of ['userId','organizationId'])assert.match(account[field],/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  }
  assert.equal(new Set(Object.values(c.accounts).map(a=>a.userId)).size,3);
  assert.equal(new Set(Object.values(c.accounts).map(a=>a.organizationId)).size,3);
 }else assert.match(c.origin,/^https:\/\/[a-f0-9]{24}--oi-offline-sync-pr2-api-nonproduction\.netlify\.app$/,'Only pinned private acceptance targets permitted');
 assert.match(c.commit,/^[a-f0-9]{40}$/);
 assert.match(c.openingCode,/^SYNTHETIC-/);
 for(const key of ['openingId','componentId','photoId','providerFacilityId'])assert.match(c[key],/^[a-f0-9-]{36}$/);
 for(const key of ['allowedFacilityIdsA','allowedFacilityIdsB']){assert(Array.isArray(c[key]));assert(c[key].length>0);}
 assert.match(c.photoSha256,/^[a-f0-9]{64}$/);
 assert(c.photoPath);assert(Array.isArray(c.purchasing)&&c.purchasing.length>=4);
 for(const p of c.purchasing){assert(p.name);assert(Array.isArray(p.openingIds)&&p.openingIds.length);assert.equal(typeof p.blocked,'boolean');assert(Number.isInteger(p.itemCount)&&p.itemCount>=0);}
 return c;
};
