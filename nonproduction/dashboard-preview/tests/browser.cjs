const {chromium}=require('playwright');const fs=require('fs');const http=require('http');const path=require('path');const assert=require('assert/strict');
const root=path.resolve(__dirname,'../site');
const a={id:'assembly-a',facility_id:'facility-a',opening_no:'PAIR-101',configuration:'paired',area:'Synthetic preview'};
const structure=['frame','active_leaf','inactive_leaf'].map(kind=>({id:kind,assembly_id:a.id,facility_id:a.facility_id,kind,material:'Wood',condition:'good'}));
const components=['unverified','worn','good'].map((condition,i)=>({id:'component-'+i,assembly_id:a.id,facility_id:a.facility_id,structure_id:i===0?'active_leaf':'inactive_leaf',component_class:'DOOR_CLOSER',manufacturer:'Synthetic brand',model:'Synthetic '+i,condition}));
const fixture={profiles:{user_type:'admin'},memberships:[{facility_id:a.facility_id,role:'admin',facilities:{id:a.facility_id,name:'Synthetic fixture'}}],opening_assemblies:[a],opening_structure:structure,opening_components:components,assembly_photos:[]};
const mock=`const fixture=${JSON.stringify(fixture)};export function createClient(){return {auth:{getSession:async()=>({data:{session:{user:{id:'test-a',email:'test@example.invalid'}}}}),onAuthStateChange:()=>{},resetPasswordForEmail:async(email,options)=>{window.resetRequest={email,options};return {}; }},from(name){const result={data:fixture[name]||[]};const q=new Proxy({}, {get(t,k){if(k==='single')return ()=>({data:Array.isArray(result.data)?result.data[0]:result.data});if(k==='then')return (resolve,reject)=>Promise.resolve(result).then(resolve,reject);return ()=>q;}});return q;},storage:{from(){return {createSignedUrl:async()=>({error:{message:'denied'}})}}}}}`;
fs.writeFileSync('/workspace/scratch/d0e95b8f5472/dashboard-finish/tests/mock-check.mjs',mock);
(async()=>{let browser,server;const results=[];try{
server=http.createServer((q,r)=>{const name=q.url.split('?')[0].replace(/^\//,'')||'index.html';const p=path.resolve(root,name);if(!p.startsWith(root+'/')){r.writeHead(403).end();return;}try{r.setHeader('Content-Type',p.endsWith('.mjs')?'application/javascript':'text/html');r.end(fs.readFileSync(p));}catch{r.writeHead(404).end();}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://esm.sh/**',r=>r.fulfill({contentType:'application/javascript',body:mock}));const origin='http://127.0.0.1:'+server.address().port;await page.goto(origin+'/portal.html');await page.locator('#rows .prow').first().waitFor({timeout:5000}).catch(async e=>{console.error(errors,await page.locator('body').innerText());throw e;});
async function test(name,fn){await fn();results.push({name,status:'PASS',scope:'local browser; mocked server'});}
await test('New hierarchy and all repeated components displayed',async()=>assert.equal(await page.locator('#rows .prow').count(),6));
await test('Unknown score remains unassessed',async()=>assert.match(await page.locator('#rows').innerText(),/Not assessed/));
await test('Door material excluded from manufacturer chart',async()=>assert.doesNotMatch(await page.locator('#mfrlist').innerText(),/Wood/));
await test('Phone table fits viewport',async()=>{const boxes=await page.locator('#rows .prow td:visible').evaluateAll(es=>es.map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})));assert(boxes.every(b=>b.left>=0&&b.right<=391),JSON.stringify(boxes));});
await test('Reset targets isolated recovery page',async()=>{await page.locator('#recoverAccount').click();await page.locator('#sendRecovery').click();await page.waitForFunction(()=>window.resetRequest);assert.equal((await page.evaluate(()=>window.resetRequest)).options.redirectTo,origin+'/opening.html');});
await page.screenshot({path:path.resolve(__dirname,'portal-mobile.png'),fullPage:true});
await page.goto(origin+'/opening.html');await page.locator('#components article').first().waitFor();
await test('Editor displays paired frame and both leaves',async()=>assert.equal(await page.locator('#structure fieldset').count(),3));
await test('Editor retains three same-class records',async()=>assert.equal(await page.locator('#components article').count(),3));
await test('Photo target options separate opening, structures and components',async()=>assert.equal(await page.locator('#photoTarget option').count(),7));
await test('Editor mobile width fits',async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)));
await test('Response-loss replay retains the same operation ID',async()=>{
 const value=await page.evaluate(async()=>{const {enqueue,pending,flush}=await import('./queue.mjs');const op=await enqueue('queue-a','preview','component',{id:'part'});let applied=false,calls=[];const sb={auth:{getSession:async()=>({data:{session:{user:{id:'queue-a'}}}})},rpc:async(name,args)=>{calls.push(args.p_id);if(!applied){applied=true;throw Error('response lost');}return {data:{status:'already_applied'}};}};try{await flush(sb,'queue-a','preview');}catch{}const count=(await pending('queue-a','preview')).length;await flush(sb,'queue-a','preview');return {count,after:(await pending('queue-a','preview')).length,calls,id:op.id};});
 assert.equal(value.count,1);assert.equal(value.after,0);assert.deepEqual(value.calls,[value.id,value.id]);
 });
await test('Different account cannot drain original owner queue',async()=>{
 const r=await page.evaluate(async()=>{const {enqueue,pending,flush}=await import('./queue.mjs');await enqueue('owner','preview','component',{});let calls=0;const sb={auth:{getSession:async()=>({data:{session:{user:{id:'other'}}}})},rpc:async()=>{calls++;}};try{await flush(sb,'owner','preview');}catch{}return {calls,count:(await pending('owner','preview')).length};});assert.deepEqual(r,{calls:0,count:1});
});
await test('Queued photograph survives page reload',async()=>{await page.evaluate(async()=>{const {enqueue}=await import('./queue.mjs');await enqueue('photo-owner','preview','photo',{storage_path:'test'},new Blob(['retained image bytes'],{type:'image/jpeg'}));});await page.reload();const text=await page.evaluate(async()=>{const {pending}=await import('./queue.mjs');return (await pending('photo-owner','preview'))[0].file.text();});assert.equal(text,'retained image bytes');});
await test('No browser runtime errors',async()=>assert.deepEqual(errors,[]));
await page.screenshot({path:path.resolve(__dirname,'editor-mobile.png'),fullPage:true});
fs.writeFileSync(path.resolve(__dirname,'browser-results.json'),JSON.stringify({results,connected:false},null,2));console.log(JSON.stringify(results,null,2));
}finally{if(browser)await browser.close();if(server)server.close();}})().catch(e=>{console.error(e);process.exitCode=1});
