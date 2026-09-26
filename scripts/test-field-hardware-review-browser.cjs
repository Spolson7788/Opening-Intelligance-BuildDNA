// Local development browser test only: real built UI, controlled API responses.
const {chromium}=require(process.env.OI_PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{let server,browser;try{
 const root=path.resolve('field-app/dist');
 server=http.createServer((req,res)=>{let p=path.join(root,req.url.split('?')[0]);if(!fs.existsSync(p)||fs.statSync(p).isDirectory())p=path.join(root,'index.html');res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(p));}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
 const token='test.'+Buffer.from(JSON.stringify({userId:'test',organizationId:'company',role:'technician'})).toString('base64')+'.test';
 let hw={id:'hardware',component_type:'closer',condition:'good',identity_status:'unresolved',review_state:'pending',replacement_required:false,manufacturer:'Synthetic',model_number:'QA',door_leaf_id:'active-leaf'};
 let saved;
 await page.route('**/api/**',r=>{let data=[];const u=new URL(r.request().url());if(u.pathname==='/api/auth/login')data={token};if(u.pathname==='/api/hardware/by-opening/opening')data=[hw];if(u.pathname==='/api/hardware/hardware'&&r.request().method()==='PATCH'){saved=r.request().postDataJSON();hw={...hw,...saved};data=hw;}return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});});
 const editUrl='http://127.0.0.1:'+server.address().port+'/opening/opening/edit-hardware/hardware';
 await page.goto(editUrl);await page.getByLabel('Email',{exact:true}).fill('synthetic@example.invalid');await page.getByLabel('Password',{exact:true}).fill('synthetic-test');await page.getByRole('button',{name:'Sign In',exact:true}).click();
 await page.getByLabel('Review',{exact:true}).waitFor();assert.equal(await page.getByLabel('Review',{exact:true}).inputValue(),'pending');assert.equal(await page.getByLabel('Condition',{exact:true}).inputValue(),'good');assert.equal(await page.getByLabel('Replacement required',{exact:true}).isChecked(),false);
 await page.getByLabel('Review',{exact:true}).selectOption('reviewed');await page.getByLabel('Condition',{exact:true}).selectOption('worn');await page.getByLabel('Product identity',{exact:true}).selectOption('established');await page.getByLabel('Replacement required',{exact:true}).check();
 await page.getByRole('button',{name:'Save Changes',exact:true}).click();await page.getByText('Saved. Returning to the opening…',{exact:true}).waitFor();
 assert.equal(saved.review_state,'reviewed');assert.equal(saved.condition,'worn');assert.equal(saved.identity_status,'established');assert.equal(saved.replacement_required,true);assert.equal(saved.door_leaf_id,undefined);assert.equal(hw.door_leaf_id,'active-leaf');
 await page.goto(editUrl);await page.getByLabel('Review',{exact:true}).waitFor();assert.equal(await page.getByLabel('Review',{exact:true}).inputValue(),'reviewed');assert.equal(await page.getByLabel('Condition',{exact:true}).inputValue(),'worn');assert.equal(await page.getByLabel('Replacement required',{exact:true}).isChecked(),true);
 console.log('PASS mobile hardware review: pending-to-reviewed, condition/identity/replacement persisted, leaf association preserved; mocked API');
 }finally{await browser?.close();server?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
