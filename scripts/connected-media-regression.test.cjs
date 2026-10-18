// Offline DOM regressions. No server, browser profile, credentials, or database.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createRequire}=require('node:module');
const {JSDOM}=require(process.env.OI_JSDOM_MODULE||'jsdom');
const tick=()=>new Promise(r=>setImmediate(r));

test('component service dates exclude other components, opening events and record timestamps',async()=>{
 const {mapSnapshot,latestComponentServiceDate}=await import('../facility-dashboard/api-client.mjs');
 const {correctiveSummary}=await import('../facility-dashboard/connected.mjs');
 const events=[{hardware_component_id:'a',event_date:'2026-10-02',created_at:'2026-12-01'},
 {hardware_component_id:null,event_date:'2026-12-02'},{hardware_component_id:'b',event_date:'2026-11-01'},
 {hardware_component_id:'a',event_date:'2026-09-01'},{hardware_component_id:'a',event_date:'2026-02-30'},
 {hardware_component_id:'a',event_date:'invalid'},{hardware_component_id:'a',event_date:null}];
 assert.equal(latestComponentServiceDate(events,'a'),'2026-10-02');
 assert.equal(latestComponentServiceDate(events,'b'),'2026-11-01');
 assert.equal(latestComponentServiceDate(events,'none'),null);
 const rows=mapSnapshot({id:'f',openings:[{id:'o',service_events:events,hardware_components:[{id:'a',component_type:'closer',condition:'worn',replacement_required:true,unit_cost:250}]}]}).opening_components;
 assert.equal(rows[0].last_service_event_date,'2026-10-02');
 assert.equal(rows[0].work_completed_at,null);
 assert.equal(correctiveSummary(rows).cost,250);
});

async function dashboardHarness(sign){
 const {buildFacilityDashboard}=await import('./build-facility-dashboard.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oi-media-test-'));buildFacilityDashboard(dir);
 const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
 const start=html.indexOf("  var detailPhotoContainer="),end=html.indexOf('\n  //',start);
 assert(start>0&&end>start);
 const dom=new JSDOM('<section id="detphotosec" style="display:none"><div id="detphotos"></div></section>');
 const add=new Function('document','sb','window',html.slice(start,end)+';return _addPhoto;')(
 dom.window.document,{storage:{from:()=>({createSignedUrl:sign})}},dom.window);
 return {dom,add,html};
}

test('generated Dashboard retains all nine labeled failures and shows access failures',async()=>{
 const {dom,add}=await dashboardHarness(async()=>({data:{signedUrl:'https://example.invalid/photo'}}));
 for(let i=0;i<9;i++)add('photo-'+i,'Closer '+i);
 await tick();
 for(const img of dom.window.document.querySelectorAll('img'))img.dispatchEvent(new dom.window.Event('error'));
 assert.equal(dom.window.document.querySelectorAll('figure').length,9);
 assert.equal(dom.window.document.querySelectorAll('[role=status]').length,9);
 assert.equal(dom.window.document.querySelector('#detphotosec').style.display,'');
 assert.match(dom.window.document.body.textContent,/Photo unavailable/);
 assert.match(dom.window.document.body.textContent,/Closer 8/);
 for(const response of [()=>Promise.reject(new Error('denied')),async()=>({data:null})]){
  const h=await dashboardHarness(response);h.add('id','Saved closer');await tick();
  assert.match(h.dom.window.document.body.textContent,/Photo unavailable/);
 }
});

test('healthy Dashboard image survives beside a failed image; stale responses cannot attach to another opening',async()=>{
 const h=await dashboardHarness(async()=>({data:{signedUrl:'https://example.invalid/photo'}}));
 h.add('good','Good');h.add('bad','Bad');await tick();
 const imgs=h.dom.window.document.querySelectorAll('img');imgs[0].dispatchEvent(new h.dom.window.Event('load'));imgs[1].dispatchEvent(new h.dom.window.Event('error'));
 assert.equal(h.dom.window.document.querySelectorAll('img').length,1);
 assert.equal(h.dom.window.document.querySelectorAll('figure').length,2);
 let resolve;const stale=await dashboardHarness(()=>new Promise(r=>{resolve=r;}));
 stale.add('pending','Old');
 stale.dom.window.document.querySelector('#detphotos').outerHTML='<div id="detphotos"></div>';
 resolve({data:{signedUrl:'https://example.invalid/old'}});await tick();
 stale.add('late-list-result','Old list');
 assert.equal(stale.dom.window.document.querySelector('#detphotos').children.length,0);
});

test('generated Dashboard labels actual event dates and counts without implying completed work or visits',async()=>{
 const h=await dashboardHarness(async()=>({data:null}));
 assert.doesNotMatch(h.html,/\bvisits?\b/);
 const servLine=h.html.split('\n').find(l=>l.includes('var serv=p.last_service_event_date')&&l.includes('<span'));
 const format=d=>d;
 const render=new Function('p','formatCalendarDate',servLine+';return serv;');
 assert.equal(render({last_service_event_date:'2026-10-02'},format),'Last service event 2026-10-02');
 assert.equal(render({work_completed_at:'2026-09-01'},format),'Work completed 2026-09-01');
 assert.match(render({},format),/No component service event/);
 assert.match(h.html,/3\+ service events in 90 days/);
});

test('Field actual SyncedMedia renders image/video and access failures honestly',async()=>{
 const fieldRequire=createRequire(path.resolve('field-app/package.json'));
 const React=fieldRequire('react'),{createRoot}=fieldRequire('react-dom/client');
 const ts=fieldRequire('typescript');
 const dom=new JSDOM('<div id="root"></div>');
 global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 const source=fs.readFileSync('field-app/src/pages/OpeningDetailPage.tsx','utf8');
 const component=source.slice(source.indexOf('export function SyncedMedia'),source.indexOf('export function OpeningDetailPage')).replace('export function','function');
 const js=ts.transpileModule(component,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
 let access=async()=>({url:'https://example.invalid/image'});
 const Media=new Function('React','useState','useEffect','fetchPhotoAccessUrl',js+';return SyncedMedia;')(React,React.useState,React.useEffect,(...args)=>access(...args));
 const root=createRoot(document.getElementById('root'));
 let key=0;
 async function render(photo){await React.act(async()=>{root.render(React.createElement(Media,{key:++key,photo,label:'Active closer'}));});}
 for(const media_type of ['photo','video']){
  await render({id:'p',media_type,storage_url:'private:key'});
  await React.act(async()=>document.querySelector(media_type==='video'?'video':'img').dispatchEvent(new dom.window.Event('error')));
  assert.match(document.body.textContent,/unavailable.*attachment record is retained/);
 }
 for(const fn of [async()=>{throw Error('denied');},async()=>({url:''})]){access=fn;await render({id:'p',storage_url:'private:key'});assert.match(document.body.textContent,/Photo unavailable/);}
 await render({id:'empty'});assert.match(document.body.textContent,/Photo unavailable/);
 access=async()=>({url:'https://example.invalid/good'});await render({id:'good',storage_url:'private:key'});
 assert.equal(document.querySelector('img').alt,'Active closer');assert.doesNotMatch(document.body.textContent,/unavailable/);
 await React.act(async()=>root.unmount());dom.window.close();
});
