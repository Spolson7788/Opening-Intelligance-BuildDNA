const {chromium}=require(process.env.OI_PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{let server,browser;try{
 const root=path.resolve('field-app/dist');
 server=http.createServer((req,res)=>{let p=path.join(root,req.url.split('?')[0]);if(!fs.existsSync(p)||fs.statSync(p).isDirectory())p=path.join(root,'index.html');res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(p));}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 browser=await chromium.launch(process.env.OI_CHROMIUM_PATH?{executablePath:process.env.OI_CHROMIUM_PATH}:{});const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const facilities=[{id:'ca',name:'California facility',state:'CA',city:'Los Angeles',service_territory:'West',buildings:[{id:'bc',name:'CA building'}]},{id:'fl',name:'Florida facility',state:'FL',city:'Miami',service_territory:'East',buildings:[]}];
 const token='test.'+Buffer.from(JSON.stringify({userId:'test',organizationId:'company',role:'technician'})).toString('base64')+'.test';
 await page.route('**/api/**',r=>{let data=[];const u=new URL(r.request().url());if(u.pathname==='/api/auth/login')data={token};if(u.pathname==='/api/portfolio/portfolios')data=[{id:'p',name:'Company'}];if(u.pathname==='/api/portfolio/properties')data=facilities;if(u.pathname==='/api/portfolio/facility-search')data={facilities,preferences:{home_state:'CA',home_territory:'West'}};return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});});
 await page.goto('http://127.0.0.1:'+server.address().port+'/setup-opening');await page.getByLabel('Email',{exact:true}).fill('synthetic@example.invalid');await page.getByLabel('Password',{exact:true}).fill('synthetic-test');await page.getByRole('button',{name:'Sign In',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#state')?.value==='CA');assert.equal(await page.getByLabel('State',{exact:true}).inputValue(),'CA');assert.equal(await page.getByLabel('My Territory',{exact:true}).inputValue(),'West');
 assert.equal(await page.locator('#facility option').count(),2);await page.locator('#facility').selectOption('ca');await page.locator('#building').selectOption('bc');
 await page.getByLabel('Find facility',{exact:true}).fill('Miami');assert.equal(await page.locator('#facility').inputValue(),'');assert.equal(await page.locator('#building').inputValue(),'');assert.equal(await page.locator('#facility option').count(),1);
 await page.getByLabel('State',{exact:true}).selectOption('');await page.getByLabel('My Territory',{exact:true}).selectOption('');assert.equal(await page.locator('#facility option').count(),2);
 assert.deepEqual(errors,[]);console.log('PASS Field App mobile: company results, home territory/state, text intersection, stale facility/building cleared; mocked API');
 }finally{await browser?.close();server?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
