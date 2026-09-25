const {chromium}=require('playwright');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../site');
const mock=`
const facilities=[{id:'ca',name:'California test',state:'CA',city:'Los Angeles'},{id:'fl',name:'Florida test',state:'FL',city:'Miami'}];
export function createClient(){return {auth:{getSession:async()=>({data:{session:{user:{id:'provider-tech'}}}}),onAuthStateChange:()=>{}},from(table){let field,value,offset=0;const q=new Proxy({}, {get(t,k){if(k==='eq')return (f,v)=>{field=f;value=v;return q;};if(k==='range')return a=>{offset=a;return q;};if(k==='then')return resolve=>{let data=[];
if(table==='facilities')data=offset?[]:facilities;
if(table==='provider_memberships')data=[{home_state:'CA'}];
if(table==='profiles')data={user_type:'vortex'};
if(table==='opening_assemblies')data=[{id:value==='fl'?'af':'ac',facility_id:value,opening_no:value==='fl'?'FL-1':'CA-1',configuration:'single'}];
if(table==='opening_assemblies'&&field==='facility_id')data=[{id:value==='fl'?'af':'ac',facility_id:value,opening_no:value==='fl'?'FL-1':'CA-1',configuration:'single'}];
if(table==='opening_components')data=[{id:'c',assembly_id:value==='fl'?'af':'ac',facility_id:value,component_class:'CLOSER',condition:'good'}];
return Promise.resolve({data}).then(resolve);};if(k==='single')return async()=>({data:{id:'ac',facility_id:value,opening_no:'CA-1',configuration:'single'}});return ()=>q;}});return q;},storage:{from:()=>({createSignedUrl:async()=>({error:{message:'No photo fixture'}})})}}}
`;
(async()=>{let server,browser;try{
 server=http.createServer((req,res)=>{const p=path.resolve(root,'.'+req.url.split('?')[0]);if(!p.startsWith(root+'/'))return res.writeHead(403).end();try{res.setHeader('Content-Type',p.endsWith('.mjs')?'application/javascript':'text/html');res.end(fs.readFileSync(p));}catch{res.writeHead(404).end();}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>(errors.push(e.message),console.error('PAGE',e.message)));
 await page.route('https://esm.sh/**',r=>r.fulfill({contentType:'application/javascript',body:mock}));const origin='http://127.0.0.1:'+server.address().port;
 for(const name of ['portal','opening']){
 await page.goto(origin+'/'+name+'.html');
 const wrap=page.locator(name==='portal'?'#facPickWrap':'#facilitySearch');
 await wrap.getByLabel('Facility',{exact:true}).waitFor();
 assert.equal(await wrap.getByLabel('State',{exact:true}).inputValue(),'CA');
 assert.equal(await wrap.getByLabel('Facility',{exact:true}).locator('option').count(),1);
 await wrap.getByLabel('State',{exact:true}).selectOption('');
 assert.equal(await wrap.getByLabel('Facility',{exact:true}).locator('option').count(),2);
 await wrap.getByLabel('Find facility',{exact:true}).fill('no such facility');
 assert.equal(await wrap.getByLabel('Facility',{exact:true}).isDisabled(),true);
 if(name==='portal')assert.equal(await page.locator('#rows').innerText(),'');
 else assert.equal(await page.locator('#selected').isHidden(),true);
 await wrap.getByLabel('Find facility',{exact:true}).fill('Miami');
 assert.equal(await wrap.getByLabel('Facility',{exact:true}).inputValue(),'fl');
 console.log('PASS '+name+': approved home state, all-state search, empty-state clearing, city search; mocked API');
 }
 assert.deepEqual(errors,[]);console.log('PASS no browser runtime errors');
 }finally{await browser?.close();server?.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
