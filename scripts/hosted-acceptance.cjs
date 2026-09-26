/** Run by an authorized operator on their own machine. Never bypasses Netlify protection. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { chromium } = require(process.env.OI_PLAYWRIGHT_MODULE || 'playwright');
const { validateConfig } = require('./hosted-acceptance-config.cjs');
const config = validateConfig(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(config.photoPath)).digest('hex'),config.photoSha256,'Approved image hash mismatch');
const output = path.resolve(process.argv[3] || 'hosted-acceptance-results.json');
const report = { started: new Date().toISOString(), origin: config.origin, commitExpected: config.commit,
  verdict: 'INCOMPLETE', checks: [], remaining: [
    'Deployment artifact bytes and commit must be independently verified.',
    'Provider assignment revocation and queued-write denial require separate execution.',
    'Account switching and service-worker restart recovery require separate execution.',
    'No production-readiness verdict is issued by this bounded runner.'
  ] };
const input = readline.createInterface({input:process.stdin,output:process.stdout});
let browser;
function save(){ fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600}); }
async function check(name,fn){
 try { const evidence=await fn(); report.checks.push({name,status:'PASS',evidence}); }
 catch { report.checks.push({name,status:'FAIL'}); save(); throw new Error(name+' failed; inspect the application. No credentials or raw responses were logged.'); }
 save();
}
async function session(label){
 const context=await browser.newContext({serviceWorkers:'block'});
 const page=await context.newPage(); let authorization;
 page.on('request',req=>{
  const u=new URL(req.url());
  if(u.origin===config.origin && u.pathname.startsWith('/api/')){
   const h=req.headers().authorization; if(h)authorization=h;
  }
 });
 await page.goto(config.origin+'/field/login');
 await input.question(`In the ${label} browser window, complete Netlify and application sign-in, open Facilities and openings, then press Enter here. Never paste credentials here. `);
 assert(authorization,'No authenticated application request observed');
 async function api(route,method='GET',body){
  const res=await context.request.fetch(config.origin+'/api'+route,{method,headers:{Authorization:authorization},data:body});
  const data=await res.json().catch(()=>null); return {status:res.status(),data};
 }
 const payload=JSON.parse(Buffer.from(authorization.split('.')[1],'base64url').toString());
 const roster=await api('/auth/users');assert.equal(roster.status,200);
 const current=roster.data.find(u=>u.id===payload.userId);
 assert(current?.is_active && current.role==='technician','A live technician role is required');
 return {page,context,api,userId:current.id,organizationId:payload.organizationId};
}
async function until(fn,ms=90000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw Error('timeout');}
async function photoCase(s,mode){
 const before=await s.api('/openings/'+config.openingId);assert.equal(before.status,200);
 assert.equal(before.data.opening_code,config.openingCode);
 assert(before.data.hardware_components.some(c=>c.id===config.componentId));
 const ids=new Set(before.data.photos.map(p=>p.id));
 await s.page.goto(config.origin+'/field/opening/'+config.openingId);
 const selector='#photo-input-'+config.openingId+'-hardware_component-'+config.componentId;
 await s.page.locator(selector).waitFor({state:'attached'});
 let dropped=false;
 if(mode==='offline')await s.context.setOffline(true);
 if(mode==='response-loss')await s.page.route('**/api/photos/offline/confirm',async route=>{
  if(dropped)return route.continue();
  const result=await route.fetch();
  if(!result.ok())return route.fulfill({response:result});
  dropped=true;await route.abort('failed');
 });
 try{
  await s.page.locator(selector).setInputFiles(path.resolve(config.photoPath));
  if(mode==='offline'){
   await until(()=>s.page.evaluate(async openingId=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('opening-intel-field');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{return await new Promise((resolve,reject)=>{const r=db.transaction('media').objectStore('media').getAll();r.onsuccess=()=>resolve(r.result.some(m=>m.openingId===openingId&&m.uploadState==='queued'&&m.blob?.size>0));r.onerror=()=>reject(r.error);});}finally{db.close();}
   },config.openingId),15000);
   await s.context.setOffline(false);
  }
  const photos=await until(async()=>{
   const r=await s.api('/openings/'+config.openingId);if(r.status!==200)return false;
   const added=r.data.photos.filter(p=>!ids.has(p.id));return added.length?added:false;
  });
  assert.equal(photos.length,1);assert.equal(photos[0].related_entity_type,'hardware_component');assert.equal(photos[0].related_entity_id,config.componentId);
  if(mode==='response-loss')assert(dropped,'No successful confirmation response was dropped');
  {
   // Reload the actual UI to exercise queue retry; do not send a fabricated replay.
   await s.page.reload();
   await until(()=>s.page.evaluate(async photoId=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('opening-intel-field');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{return await new Promise((resolve,reject)=>{const r=db.transaction('media').objectStore('media').get(photoId);r.onsuccess=()=>resolve(r.result?.uploadState==='verified');r.onerror=()=>reject(r.error);});}finally{db.close();}
   },photos[0].id));
  }
  const after=await s.api('/openings/'+config.openingId);assert.equal(after.status,200);
  assert.equal(after.data.photos.filter(p=>!ids.has(p.id)).length,1);
  return {photoId:photos[0].id,association:config.componentId,responseDropped:dropped};
 }finally{await s.context.setOffline(false);if(mode==='response-loss')await s.page.unroute('**/api/photos/offline/confirm');}
}
(async()=>{
 browser=await chromium.launch({headless:false});
 const a=await session('authorized synthetic technician A');
 await check('A reads only expected facilities',async()=>{
  const r=await a.api('/portfolio/facility-search');assert.equal(r.status,200);
  assert.deepEqual(r.data.facilities.map(f=>f.id).sort(),[...config.allowedFacilityIdsA].sort());return {count:r.data.facilities.length};
 });
 const b=await session('separate synthetic company technician B');
 assert.notEqual(a.organizationId,b.organizationId,'Two different company memberships are required');
 await check('B cannot read A opening or private photo',async()=>{
  const opening=await b.api('/openings/'+config.openingId),photo=await b.api('/photos/'+config.photoId+'/access');
  assert.equal(opening.status,404);assert.equal(photo.status,404);return {opening:opening.status,photo:photo.status};
 });
 await check('B reads only expected facilities',async()=>{
  const r=await b.api('/portfolio/facility-search');assert.equal(r.status,200);
  assert.deepEqual(r.data.facilities.map(f=>f.id).sort(),[...config.allowedFacilityIdsB].sort());return {count:r.data.facilities.length};
 });
 for(const scenario of config.purchasing){
  await check('Purchasing '+scenario.name,async()=>{
   const r=await a.api('/purchasing/review','POST',{opening_ids:scenario.openingIds});assert.equal(r.status,200);
   assert.equal(r.data.blocked,scenario.blocked);assert.equal(r.data.items.length,scenario.itemCount);
   return {blocked:r.data.blocked,itemCount:r.data.items.length};
  });
 }
 await check('Offline capture reconnects without duplication',()=>photoCase(a,'offline'));
 await check('Lost confirmation response recovers without duplication',()=>photoCase(a,'response-loss'));
 report.verdict='BOUNDED_CHECKS_PASS_FULL_ACCEPTANCE_INCOMPLETE';save();
 console.log('Bounded checks passed. Full acceptance remains incomplete; see remaining items in report.');
})().catch(e=>{report.verdict='FAILED_OR_INCOMPLETE';save();console.error('Runner stopped. Inspect the failed check and browser; raw errors are withheld to protect session URLs.');process.exitCode=1;})
.finally(async()=>{input.close();await browser?.close();});
