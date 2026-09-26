const {chromium}=require('playwright');
const fs=require('fs'),http=require('http'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../site');
(async()=>{
  const server=http.createServer((req,res)=>{const file=path.resolve(root,req.url.slice(1).split('?')[0]);if(!file.startsWith(root+'/'))return res.writeHead(403).end();try{res.setHeader('Content-Type',file.endsWith('.mjs')?'application/javascript':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    let mode='recorded';
    await page.route('https://esm.sh/**',route=>route.fulfill({contentType:'application/javascript',body:`
      const mode=${JSON.stringify(mode)};
      const fixture={profiles:{user_type:'admin'},memberships:[{facilities:{id:'a',name:'Synthetic financial check'}}],opening_assemblies:[{id:'o',facility_id:'a',opening_no:'101',area:'Synthetic'}],opening_structure:[],opening_components:[
        {id:'1',assembly_id:'o',facility_id:'a',component_class:'closer',condition:'worn',disposition:'replace',repair_cost:250},
        {id:'2',assembly_id:'o',facility_id:'a',component_class:'closer',condition:'good',disposition:'serviceable',repair_cost:0},
        {id:'3',assembly_id:'o',facility_id:'a',component_class:'closer',condition:'good',disposition:'serviceable',repair_cost:null,work_completed_at:'2026-09-21'}
      ],service_events:[{id:'event',opening_no:'101',performed_at:new Date().toISOString(),work_performed:'Synthetic adjustment',cost:mode==='unpriced'?null:85}]};
      export function createClient(){return {auth:{getSession:async()=>({data:{session:{user:{id:'u',email:'test@example.invalid'}}}}),onAuthStateChange:()=>{}},from(table){let select='';const q=new Proxy({}, {get(_,key){if(key==='select')return v=>{select=v;return q;};if(key==='then')return resolve=>resolve(mode==='error'&&table==='service_events'?{error:{message:'unavailable'}}:{data:fixture[table]||[]});if(key==='single')return ()=>({data:fixture[table]});return ()=>q;}});return q;}};}
    `}));
    const origin='http://127.0.0.1:'+server.address().port;
    for(mode of ['recorded','unpriced','error']){
      await page.goto(origin+'/portal.html');
      await page.waitForFunction(()=>!document.querySelector('#quarterService')&&document.querySelector('#kpis')?.innerText.includes('Recorded service this quarter'));
      const text=await page.locator('#kpis').innerText();
      assert.match(text,/\$250/);assert.match(text,/1 replacement priced/);
      const service=await page.locator('.tile').filter({hasText:'Recorded service this quarter'}).innerText();
      if(mode==='recorded'){assert.match(service,/\$85/);assert.match(service,/1 service event/);}
      if(mode==='unpriced'){assert.match(service,/Not recorded/);assert.match(service,/1 without cost/);assert.doesNotMatch(service,/\$0/);}
      if(mode==='error'){assert.match(service,/unavailable/);assert.doesNotMatch(service,/\$0/);}
    }
    assert.deepEqual(errors,[]);
    console.log('3 rendered financial cases PASS (mocked browser, not deployed evidence).');
  }finally{if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
