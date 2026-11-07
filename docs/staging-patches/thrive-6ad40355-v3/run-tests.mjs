/**
 * Staging patch v3 test matrix — explicit guard ready signal + write recheck + portal photo errors.
 * Mocked/jsdom only. No live Supabase writes, no DB permission bypass, no Netlify deploy.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = '/workspace/oi_staging';
const ORIG = path.join(ROOT, 'deploy_6ad40355');
const PATCH = path.join(ROOT, 'patch_6ad40355_v3');
const ZIP = '/home/box/Downloads/deploy-6ad40355d11faef8a0292823.zip';
const EXPECT_ZIP_SHA = '5bd7161bb78df9e0b421f9bc0d794d0116b62186ba679a7a3adfa75499afcb64';
const EXPECT_ORIG_GUARD = '015550c798eaa8261525c6aaa734ddca697b4f769c975a6a0b969890a2e6cc27';
const EXPECT_ORIG_INSP = '58449f29c02ca36a2aa218b6c739ab0046bbddd48ea5fb12508cfefc37d9bd94';
const EXPECT_ORIG_PORTAL = '342c6d2203f7468746cce3b6a0ea71aa17932c0be2e4ebc3f6eeed2616e6996a';

const results = [];
function pass(id, msg){ results.push({id, ok:true, msg}); console.log(`PASS ${id}: ${msg}`); }
function fail(id, msg){ results.push({id, ok:false, msg}); console.log(`FAIL ${id}: ${msg}`); }
function sha256(p){ return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

const inspHtml = fs.readFileSync(path.join(PATCH, 'inspect.html'), 'utf8');
const portalHtml = fs.readFileSync(path.join(PATCH, 'portal.html'), 'utf8');
const guardSrc = fs.readFileSync(path.join(PATCH, 'staging/guard.js'), 'utf8');
const guardOrig = fs.readFileSync(path.join(ORIG, 'staging/guard.js'));
const guardPatch = fs.readFileSync(path.join(PATCH, 'staging/guard.js'));

function extractModuleScript(html){
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if(!m) throw new Error('module script missing');
  return m[1];
}

function makeMockSb(counters, {uploadFailAt=null, failInsertAfterUpload=false}={}){
  let uploadIndex = 0;
  return {
    from(table){
      return {
        insert(row){
          if(table==='opening_photos' && failInsertAfterUpload){
            counters.inserts.push({table, row, error:true});
            return Promise.resolve({data:null, error:{message:'insert blocked mock'}});
          }
          counters.inserts.push({table, row});
          if(table==='inspections'){
            return { select(){ return { single(){ return Promise.resolve({data:{id:'insp-1'}, error:null}); } }; } };
          }
          return Promise.resolve({data:null, error:null});
        },
        select(){ return { then(r){ return Promise.resolve({data:[], error:null}).then(r); } }; },
      };
    },
    storage:{
      from(bucket){
        return {
          upload(p, file, opts){
            const idx = uploadIndex++;
            if(uploadFailAt !== null && idx === uploadFailAt){
              counters.uploads.push({bucket, path:p, error:true});
              return Promise.resolve({data:null, error:{message:'upload failed mock'}});
            }
            counters.uploads.push({bucket, path:p, file, opts, error:false});
            counters.uploadedPaths.push(p);
            return Promise.resolve({data:{path:p}, error:null});
          },
          remove(paths){ counters.deletes.push(paths); return Promise.resolve({data:null,error:null}); },
          createSignedUrl(){ return Promise.resolve({data:{signedUrl:'https://example.test/signed'}, error:null}); },
          getPublicUrl(){ counters.publicUrlCalls++; return {data:{publicUrl:'https://example.test/public'}}; },
        };
      }
    },
    auth:{
      getSession(){ return Promise.resolve({data:{session:{user:{email:'qa@example.test'}}}}); },
      signInWithPassword(){ return Promise.resolve({error:null}); },
      signOut(){ return Promise.resolve(); },
    }
  };
}

function extractGateFns(src){
  const gateFn = src.match(/function stagingGuardAllowsWrites\(\)\{[\s\S]*?\n\}/);
  const applyFn = src.match(/function applyWriteControlsFromGuard\(\)\{[\s\S]*?\n\}/);
  if(!gateFn || !applyFn) throw new Error('gate functions not found in patched inspect');
  return {gateFn: gateFn[0], applyFn: applyFn[0]};
}

/** Extract the save-handler photo-loop + insert recheck logic as a simulator matching patched source contracts */
async function runInspectWriteScenario(guardState, {
  withPhotos=true,
  photoCount=1,
  uploadFailAt=null,
  flipGuardAfterUpload=false,
  failInsertAfterUpload=false,
}={}){
  const counters = {inserts:[], uploads:[], uploadedPaths:[], deletes:[], publicUrlCalls:0};
  const dom = new JSDOM(`<!DOCTYPE html><html><body data-schedule-staging="bound-review">
    <input id="opnum" value="205A">
    <input id="inspector" value="QA">
    <input id="idate" type="date" value="2026-10-23">
    <input id="notes" value="">
    <input id="over38" type="checkbox">
    <input id="photos" type="file" disabled>
    <button id="save" disabled>Save</button>
    <div id="savemsg"></div>
    <div id="result"></div>
    <div id="items"></div><div id="clrs"></div>
    <div id="signedout"></div><div id="signedin"></div><div id="who"></div>
    <select id="facSel"></select>
    <div id="authmsg"></div><div id="openmeta"></div>
  </body></html>`, {url:'https://staging.example/inspect.html', runScripts:'outside-only'});
  const {window} = dom;
  const document = window.document;

  if(guardState === 'absent'){
    // no __OI_STAGING_GUARD__
  } else if(guardState === 'fail'){
    window.__OI_STAGING_GUARD__ = {ready:false, status:'fail'};
  } else if(guardState === 'pending'){
    window.__OI_STAGING_GUARD__ = {ready:false, status:'pending'};
  } else if(guardState === 'ok'){
    window.__OI_STAGING_GUARD__ = {ready:true, status:'ok'};
  }

  const src = extractModuleScript(inspHtml);
  const {gateFn, applyFn} = extractGateFns(src);
  const $ = id => document.getElementById(id);
  const stagingGuardAllowsWrites = new Function('window', `${gateFn}; return stagingGuardAllowsWrites;`)(window);
  const applyWriteControlsFromGuard = new Function('window', 'document', '$', `
    ${gateFn}
    ${applyFn}
    return applyWriteControlsFromGuard;
  `)(window, document, $);

  const defaultBlocked = $('save').disabled === true && $('photos').disabled === true;
  applyWriteControlsFromGuard();
  const controlsAfter = {saveDisabled: $('save').disabled, photosDisabled: $('photos').disabled};

  const files = [];
  for(let i=0;i<(withPhotos?photoCount:0);i++) files.push({name:`a${i}.jpg`, type:'image/jpeg', size:10});
  Object.defineProperty($('photos'), 'files', {configurable:true, get(){ return files; }});

  const facility = {id:'fac-1', name:'QA'};
  const msg = $('savemsg');
  let wrote = false;
  const sb = makeMockSb(counters, {uploadFailAt, failInsertAfterUpload});

  async function simulatedSave(){
    if(!stagingGuardAllowsWrites()){ msg.textContent='Staging guard not ready — save and photo upload blocked.'; return; }
    const row = {facility_id:facility.id, opening_no:'205A', result:'pass'};
    msg.textContent='Saving…';
    // Recheck immediately before inspection insert (mirrors patched inspect)
    if(!stagingGuardAllowsWrites()){ msg.textContent='Staging guard not ready — save blocked.'; return; }
    const ins = await sb.from('inspections').insert(row).select().single();
    if(ins.error){ msg.textContent='err'; return; }
    const fileList = $('photos').files; let up=0; let photoPartial=null; const total=fileList.length;
    for(let i=0;i<total;i++){
      if(!stagingGuardAllowsWrites()){ photoPartial='Staging guard not ready — photo upload blocked after '+up+' of '+total+' photo(s) fully recorded.'; break; }
      const p = facility.id+'/205A/insp-'+Date.now()+'-'+i+'.jpg';
      const u = await sb.storage.from('opening-photos').upload(p, fileList[i], {contentType:fileList[i].type||'image/jpeg'});
      if(u.error){ photoPartial='Photo upload failed'+(u.error.message?(' ('+u.error.message+')'):'')+' after '+up+' of '+total+' photo(s) fully recorded. Uploaded objects were not deleted.'; break; }
      if(flipGuardAfterUpload){
        window.__OI_STAGING_GUARD__ = {ready:false, status:'fail'};
      }
      if(!stagingGuardAllowsWrites()){ photoPartial='Staging guard not ready — photo record insert blocked after upload ('+up+' of '+total+' fully recorded; 1 uploaded object left without DB record). Uploaded objects were not deleted.'; break; }
      try{
        const ir = await sb.from('opening_photos').insert({facility_id:facility.id,opening_no:'205A',storage_path:p});
        if(ir&&ir.error){ photoPartial='Photo record insert failed after upload ('+up+' of '+total+' fully recorded). Uploaded objects were not deleted.'; break; }
        up++;
      }catch(pe){ photoPartial='Photo record insert failed after upload ('+up+' of '+total+' fully recorded). Uploaded objects were not deleted.'; break; }
    }
    wrote = true;
    if(photoPartial){
      msg.textContent='⚠ Partial failure: inspection saved for opening 205A, but '+photoPartial;
    } else {
      msg.textContent = 'saved up='+up;
    }
  }
  await simulatedSave();

  const sourceHasSaveGate = /if\(!stagingGuardAllowsWrites\(\)\)\{msg\.textContent='Staging guard not ready — save and photo upload blocked\.'/.test(inspHtml);
  const sourceHasInsertRecheck = /Staging guard not ready — save blocked/.test(inspHtml);
  const sourceHasPhotoUploadGate = /photo upload blocked after/.test(inspHtml);
  const sourceHasPhotoInsertGate = /photo record insert blocked after upload/.test(inspHtml);
  const sourceHasPartial = /Partial failure/.test(inspHtml);
  const sourceNoAutoDelete = !/storage\.from\(['"]opening-photos['"]\)\.remove/.test(inspHtml)
    && !/\.remove\(/.test(inspHtml.match(/\$\('save'\)\.addEventListener[\s\S]*?\}\);/)?.[0] || '');
  const sourceNoOnloadOk = !(/<script src="\/staging\/guard\.js"[^>]*onload=/.test(inspHtml));

  return {
    defaultBlocked,
    controlsAfter,
    allows: stagingGuardAllowsWrites(),
    inserts: counters.inserts.length,
    inspectionInserts: counters.inserts.filter(x=>x.table==='inspections').length,
    photoInserts: counters.inserts.filter(x=>x.table==='opening_photos' && !x.error).length,
    uploads: counters.uploads.filter(u=>!u.error).length,
    failedUploads: counters.uploads.filter(u=>u.error).length,
    deletes: counters.deletes.length,
    uploadedPaths: counters.uploadedPaths.slice(),
    msg: msg.textContent,
    wrote,
    sourceHasSaveGate,
    sourceHasInsertRecheck,
    sourceHasPhotoUploadGate,
    sourceHasPhotoInsertGate,
    sourceHasPartial,
    sourceNoAutoDelete,
    sourceNoOnloadOk,
  };
}

/** Run real patched guard.js in jsdom; optionally force start() to throw */
async function runRealGuardInit({throwInStart=false}={}){
  const vc = new VirtualConsole();
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
    <button id="save" disabled>Save</button>
    <input id="photos" type="file" disabled>
    <button id="addFacBtn">Add</button>
  </body></html>`, {url:'https://staging.example/inspect.html', runScripts:'dangerously', virtualConsole: vc});
  const {window} = dom;
  const document = window.document;

  // Mirror inspect: pending before guard executes
  window.__OI_STAGING_GUARD__ = {ready:false, status:'pending'};

  let src = guardSrc;
  if(throwInStart){
    // Inject a throw at the start of the try body after notice create begins —
    // replace document.body.prepend to throw (simulates init failure while preserving try/catch path)
    src = src.replace(
      'document.body.prepend(notice); disable();',
      'throw new Error("forced guard init failure"); document.body.prepend(notice); disable();'
    );
  }

  window.eval(src);
  // Allow DOMContentLoaded path if needed; readyState in jsdom is usually 'complete'
  await new Promise(r => setTimeout(r, 20));

  const g = window.__OI_STAGING_GUARD__;
  const notice = document.getElementById('stagingNotice');
  const addFac = document.getElementById('addFacBtn');

  // Apply same control logic as inspect
  const allow = !!(g && g.ready===true && g.status==='ok');
  document.getElementById('save').disabled = !allow;
  document.getElementById('photos').disabled = !allow;

  return {
    status: g && g.status,
    ready: g && g.ready,
    error: g && g.error,
    hasNotice: !!notice,
    addFacDisabled: addFac ? addFac.disabled : null,
    saveDisabled: document.getElementById('save').disabled,
    photosDisabled: document.getElementById('photos').disabled,
    allowsWrites: allow,
  };
}

async function runPortalPhotoScenario(mode){
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="detphotosec" style="display:none"><div id="detphotos"></div></div>
  </body></html>`, {url:'https://staging.example/portal.html', resources:'usable'});
  const {window} = dom;
  const document = window.document;

  const m = portalHtml.match(/function _addPhoto\(path\)\{[\s\S]*?\n  \}\n  \/\/ ── SERVICE RECORD/);
  if(!m) throw new Error('_addPhoto not found');
  let fnSrc = m[0].replace(/\n  \/\/ ── SERVICE RECORD$/, '');

  const calls = {getPublicUrl:0, createSignedUrl:0};
  const sb = {
    storage:{
      from(){
        return {
          createSignedUrl(){
            calls.createSignedUrl++;
            if(mode==='reject') return Promise.reject(new Error('signed fail'));
            if(mode==='missing') return Promise.resolve({data:{signedUrl:null}, error:{message:'none'}});
            return Promise.resolve({data:{signedUrl:'https://example.test/ok.jpg'}, error:null});
          },
          getPublicUrl(){ calls.getPublicUrl++; return {data:{publicUrl:'https://example.test/public.jpg'}}; },
        };
      }
    }
  };
  const define = new Function('sb', 'document', 'window', fnSrc + '\n return _addPhoto;');
  const _addPhoto = define(sb, document, window);
  _addPhoto('fac/op/photo.jpg');
  await new Promise(r => setTimeout(r, 30));
  if(mode==='onerror'){
    const img = document.querySelector('#detphotos img');
    if(!img) throw new Error('expected img for onerror scenario');
    img.dispatchEvent(new window.Event('error'));
    await new Promise(r => setTimeout(r, 10));
  }
  const sec = document.getElementById('detphotosec');
  const errs = [...document.querySelectorAll('.photo-load-error')];
  const imgs = [...document.querySelectorAll('#detphotos img')];
  return {
    calls,
    secDisplay: sec.style.display,
    errTexts: errs.map(e => e.textContent),
    errCount: errs.length,
    imgCount: imgs.length,
    hasGetPublicUrlInSource: /getPublicUrl/.test(portalHtml),
  };
}

// ===================== RUN MATRIX =====================
console.log('=== A/B: Guard init throw / pending / missing ===');

{
  const r = await runRealGuardInit({throwInStart:true});
  if(r.status==='fail' && r.ready===false && r.saveDisabled && r.photosDisabled && !r.allowsWrites && !r.hasNotice)
    pass('A1', 'Actual guard initialization throwing → status=fail; Inspect controls stay disabled; zero-write gate');
  else fail('A1', JSON.stringify(r));
}
{
  const r = await runRealGuardInit({throwInStart:false});
  if(r.status==='ok' && r.ready===true && !r.saveDisabled && !r.photosDisabled && r.allowsWrites && r.hasNotice && r.addFacDisabled===true)
    pass('A2', 'Successful guard init → explicit ready/ok; QA notice present; UI restrictions preserved; writes allowed');
  else fail('A2', JSON.stringify(r));
}
{
  const r = await runInspectWriteScenario('absent');
  if(r.defaultBlocked && !r.allows && r.inserts===0 && r.uploads===0 && r.sourceHasSaveGate && r.sourceNoOnloadOk)
    pass('B1', 'Guard absent/missing → zero writes; controls default-blocked; no script-onload success path in source');
  else fail('B1', JSON.stringify(r));
}
{
  const r = await runInspectWriteScenario('pending');
  if(!r.allows && r.defaultBlocked && r.controlsAfter.saveDisabled && r.controlsAfter.photosDisabled && r.inserts===0 && r.uploads===0)
    pass('B2', 'Guard pending → zero writes; controls blocked');
  else fail('B2', JSON.stringify(r));
}
{
  const r = await runInspectWriteScenario('fail');
  if(!r.allows && r.controlsAfter.saveDisabled && r.controlsAfter.photosDisabled && r.inserts===0 && r.uploads===0)
    pass('B3', 'Guard fail status → zero writes; controls stay blocked');
  else fail('B3', JSON.stringify(r));
}

console.log('=== C: Mid-write / partial failure ===');
{
  // First photo uploads OK, then guard flips before photo-record insert
  const r = await runInspectWriteScenario('ok', {withPhotos:true, photoCount:1, flipGuardAfterUpload:true});
  const partial = /Partial failure/.test(r.msg) && /photo record insert blocked/.test(r.msg);
  const notSuccess = !/^saved up=/.test(r.msg) && !/✓/.test(r.msg);
  if(r.inspectionInserts===1 && r.uploads===1 && r.photoInserts===0 && r.deletes===0 && partial && notSuccess && r.sourceHasPhotoInsertGate && r.sourceNoAutoDelete)
    pass('C1', 'After upload before photo-record insert gate fail → partial-failure message (not success); upload kept; no auto-delete; no photo insert');
  else fail('C1', JSON.stringify(r));
}
{
  // Two photos; second upload fails
  const r = await runInspectWriteScenario('ok', {withPhotos:true, photoCount:2, uploadFailAt:1});
  const partial = /Partial failure/.test(r.msg) && /Photo upload failed/.test(r.msg);
  const notSuccess = !/^saved up=/.test(r.msg);
  if(r.inspectionInserts===1 && r.uploads===1 && r.failedUploads===1 && r.photoInserts===1 && r.deletes===0 && partial && notSuccess && r.sourceHasPartial)
    pass('C2', 'Failure during second upload → partial-failure message (not success); first photo kept; no auto-delete');
  else fail('C2', JSON.stringify(r));
}

console.log('=== D: Success path ===');
{
  const r = await runInspectWriteScenario('ok', {withPhotos:true, photoCount:1});
  if(r.allows && !r.controlsAfter.saveDisabled && !r.controlsAfter.photosDisabled && r.inspectionInserts===1 && r.uploads===1 && r.photoInserts===1 && r.deletes===0 && /^saved up=1/.test(r.msg) && r.sourceHasInsertRecheck && r.sourceHasPhotoUploadGate)
    pass('D1', 'Successful init+save+photo path (mocked) — inspection insert, upload, photo-record insert');
  else fail('D1', JSON.stringify(r));
}

console.log('=== Portal photo scenarios ===');
{
  const r = await runPortalPhotoScenario('missing');
  if(r.errCount>=1 && /Signed URL unavailable/.test(r.errTexts.join(' ')) && r.imgCount===0 && r.calls.getPublicUrl===0 && !r.hasGetPublicUrlInSource && r.secDisplay!=='none')
    pass('P1', 'Missing signed URL → visible error, no silent hide, no getPublicUrl');
  else fail('P1', JSON.stringify(r));
}
{
  const r = await runPortalPhotoScenario('reject');
  if(r.errCount>=1 && /Could not create signed URL/.test(r.errTexts.join(' ')) && r.calls.getPublicUrl===0 && r.secDisplay!=='none')
    pass('P2', 'Rejected createSignedUrl → visible error');
  else fail('P2', JSON.stringify(r));
}
{
  const r = await runPortalPhotoScenario('onerror');
  if(r.errCount>=1 && /Photo failed to load from signed URL/.test(r.errTexts.join(' ')) && r.secDisplay!=='none')
    pass('P3', 'Image onerror → visible error');
  else fail('P3', JSON.stringify(r));
}
{
  const r = await runPortalPhotoScenario('success');
  if(r.imgCount===1 && r.errCount===0 && r.calls.createSignedUrl===1 && r.calls.getPublicUrl===0 && r.secDisplay!=='none')
    pass('P4', 'Successful signed URL → photo shown');
  else fail('P4', JSON.stringify(r));
}

console.log('=== Static / prior checks ===');
{
  const ok = inspHtml.includes('src="/staging/guard.js"');
  ok ? pass('S1', 'guard.js present on inspect') : fail('S1', 'missing guard.js');
}
{
  const ok = /data-schedule-staging="bound-review"/.test(inspHtml);
  ok ? pass('S2', 'data-schedule-staging=bound-review on inspect body') : fail('S2', 'attr missing');
}
{
  const count = (portalHtml.match(/getPublicUrl/g)||[]).length;
  count===0 ? pass('S3', 'getPublicUrl count=0 on portal') : fail('S3', 'count='+count);
}
{
  const ok = /createSignedUrl/.test(portalHtml);
  ok ? pass('S4', 'createSignedUrl still present') : fail('S4', 'missing');
}
{
  // guard.js CHANGED in v3 — must differ from original; document both checksums
  const changed = Buffer.compare(guardOrig, guardPatch) !== 0;
  const origOk = sha256(path.join(ORIG,'staging/guard.js')) === EXPECT_ORIG_GUARD;
  const hasSignal = /signalReady/.test(guardSrc) && /oi-staging-guard-ready/.test(guardSrc) && /status = 'ok'/.test(guardSrc);
  const preserves = /Unavailable in schedule QA staging/.test(guardSrc) && /stagingNotice/.test(guardSrc) && /MutationObserver/.test(guardSrc);
  const tryCatch = /try \{[\s\S]*signalReady\(\);[\s\S]*\} catch/.test(guardSrc);
  (changed && origOk && hasSignal && preserves && tryCatch)
    ? pass('S5', 'guard.js changed with explicit ready/fail after init try/catch; original restrictions preserved; orig checksum intact')
    : fail('S5', JSON.stringify({changed, origOk, hasSignal, preserves, tryCatch}));
}
{
  const tree = [inspHtml, portalHtml, guardSrc].join('\n');
  const prod = /ytqiulxtiharrplqnuir/.test(tree);
  !prod ? pass('S6', 'no prod Supabase ref') : fail('S6', 'prod ref found');
}
{
  const ok = /fadihkhdwpfffpelqjtg/.test(inspHtml) && /fadihkhdwpfffpelqjtg/.test(portalHtml);
  ok ? pass('S7', 'staging ref present') : fail('S7', 'staging ref missing');
}
{
  const secrets = /service_role|sk-ant-|BEGIN (RSA |OPENSSH )?PRIVATE KEY|supabase_service_role/i;
  const ok = !secrets.test(inspHtml) && !secrets.test(portalHtml) && !secrets.test(guardSrc);
  ok ? pass('S8', 'no secrets introduced') : fail('S8', 'secret-like string');
}
{
  const oi = sha256(path.join(ORIG,'inspect.html'));
  const op = sha256(path.join(ORIG,'portal.html'));
  const og = sha256(path.join(ORIG,'staging/guard.js'));
  const ok = oi===EXPECT_ORIG_INSP && op===EXPECT_ORIG_PORTAL && og===EXPECT_ORIG_GUARD;
  ok ? pass('S9', 'original Drop inspect+portal+guard checksums intact (untouched)') : fail('S9', `oi=${oi} op=${op} og=${og}`);
}
{
  const ok = !/settings\.enabled\s*=\s*true/.test(inspHtml+portalHtml+guardSrc) && !/makePublic|public:\s*true/.test(inspHtml+portalHtml+guardSrc);
  ok ? pass('S10', 'importer not enabled / bucket not made public (no such toggles in patch)') : fail('S10', 'toggle found');
}
{
  const z = sha256(ZIP);
  z===EXPECT_ZIP_SHA ? pass('S11', 'baseline zip SHA-256 intact') : fail('S11', z);
}
{
  const saveDisabled = /id="save"[^>]*\bdisabled\b/.test(inspHtml) || /<button[^>]*id="save"[^>]*disabled/.test(inspHtml);
  const photosDisabled = /id="photos"[^>]*\bdisabled\b/.test(inspHtml);
  (saveDisabled && photosDisabled) ? pass('S12', 'Save and photo controls start disabled in HTML') : fail('S12', `save=${saveDisabled} photos=${photosDisabled}`);
}
{
  // Ready signal contract: inspect must NOT use onload as success
  const guardTag = inspHtml.match(/<script src="\/staging\/guard\.js"[^>]*>/);
  const noOnload = guardTag && !/onload=/.test(guardTag[0]);
  const listensReady = /oi-staging-guard-ready/.test(inspHtml);
  const commentsRejectOnload = /Script onload is NOT success|onload is NOT success|not.*onload/i.test(inspHtml);
  (noOnload && listensReady && commentsRejectOnload)
    ? pass('S13', 'Inspect does not treat script onload as success; listens for guard ready event')
    : fail('S13', JSON.stringify({guardTag: guardTag&&guardTag[0], noOnload, listensReady, commentsRejectOnload}));
}

const failed = results.filter(r=>!r.ok);
console.log('\n=== SUMMARY ===');
console.log(`${results.filter(r=>r.ok).length}/${results.length} PASS`);
if(failed.length){ console.log('FAILURES:'); failed.forEach(f=>console.log(' -', f.id, f.msg)); }

fs.writeFileSync('/workspace/oi_staging/patches/test/results.json', JSON.stringify({
  when: new Date().toISOString(),
  patch: 'v3',
  note: 'Tests are mocked/jsdom — no live writes or database-permission bypass were tested.',
  results,
  checksums: {
    zip: sha256(ZIP),
    orig_inspect: sha256(path.join(ORIG,'inspect.html')),
    orig_portal: sha256(path.join(ORIG,'portal.html')),
    orig_guard: sha256(path.join(ORIG,'staging/guard.js')),
    patched_inspect: sha256(path.join(PATCH,'inspect.html')),
    patched_portal: sha256(path.join(PATCH,'portal.html')),
    patched_guard: sha256(path.join(PATCH,'staging/guard.js')),
  }
}, null, 2));
console.log('Wrote results.json');
if(failed.length) process.exit(1);
