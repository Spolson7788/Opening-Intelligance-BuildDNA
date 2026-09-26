const assert=require('node:assert/strict');
exports.validateConfig=function(c){
 assert.match(c.origin,/^https:\/\/[a-f0-9]{24}--oi-offline-sync-pr2-api-nonproduction\.netlify\.app$/,'Only immutable protected nonproduction previews permitted');
 assert.match(c.commit,/^[a-f0-9]{40}$/);
 assert.match(c.openingCode,/^SYNTHETIC-/);
 for(const key of ['openingId','componentId','photoId'])assert.match(c[key],/^[a-f0-9-]{36}$/);
 for(const key of ['allowedFacilityIdsA','allowedFacilityIdsB']){assert(Array.isArray(c[key]));assert(c[key].length>0);}
 assert.match(c.photoSha256,/^[a-f0-9]{64}$/);
 assert(c.photoPath);assert(Array.isArray(c.purchasing)&&c.purchasing.length>=4);
 for(const p of c.purchasing){assert(p.name);assert(Array.isArray(p.openingIds)&&p.openingIds.length);assert.equal(typeof p.blocked,'boolean');assert(Number.isInteger(p.itemCount)&&p.itemCount>=0);}
 return c;
};
