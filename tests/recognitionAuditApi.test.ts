import {it,expect,vi,afterEach} from 'vitest';
import sharp from 'sharp';
import request from 'supertest';
vi.mock('tesseract.js',()=>({PSM:{SINGLE_LINE:'7',SPARSE_TEXT:'11'},createWorker:vi.fn(async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:'Norton 7500',confidence:75}}),terminate:async()=>{}}))}));
import {pool} from '../src/db/pool';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
afterEach(()=>{vi.unstubAllGlobals();delete process.env.OI_RECOGNITION_ENABLED;delete process.env.OI_RECOGNITION_SHADOW_ENABLED;delete process.env.ANTHROPIC_API_KEY;});
it('retains per-call audit and per-view OCR even when primary analysis fails',async()=>{
 const org=await signupTestOrg('Audit fixture'),hierarchy=await createPortfolioHierarchy(org.token),opening=await createTestOpening(org.token,hierarchy.buildingId);
 process.env.OI_RECOGNITION_ENABLED='true';process.env.OI_RECOGNITION_SHADOW_ENABLED='true';process.env.ANTHROPIC_API_KEY='fixture-only';
 const image=await sharp({create:{width:64,height:40,channels:3,background:'white'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const fetch=vi.fn(async(_url,init)=>{
  const req=JSON.parse(init.body);
  for(const block of req.messages[0].content.filter((c:any)=>c.type==='image')){expect(block.source.media_type).toBe('image/jpeg');const m=await sharp(Buffer.from(block.source.data,'base64')).metadata();expect(Math.max(m.width!,m.height!)).toBeLessThanOrEqual(2000);expect(m.orientation).toBeUndefined();}
  const prompt=req.messages[0].content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join(' ');
  if(prompt.includes('Locate identification markings'))return Response.json({content:[{type:'text',text:JSON.stringify({regions:[{photo_index:0,x:.1,y:.1,w:.5,h:.5,rotation:0}]})}],usage:{input_tokens:10,output_tokens:10}});
  if(prompt.includes('Find and read product label characters'))return Response.json({content:[{type:'text',text:JSON.stringify({reads:[{crop_index:0,text:'Norton 7500'}]})}],usage:{input_tokens:20,output_tokens:20}});
  return Response.json({error:{message:'unavailable'}},{status:503});
 });vi.stubGlobal('fetch',fetch);
 const response=await request(app).post('/api/recognition').set('Authorization','Bearer '+org.token).send({opening_id:opening.id,images:[image.toString('base64')],media_type:'image/jpeg'});
 expect(response.status).toBe(502);
 const run=(await pool.query('SELECT * FROM recognition_runs WHERE opening_id=$1',[opening.id])).rows[0];
 expect(run.status).toBe('failed');expect(run.stage_one.failure).toEqual({http_status:502,code:'recognition_provider_temporarily_unavailable'});expect(run.stage_one.libraries.sharp).toBeTruthy();expect(run.stage_one.libraries.tesseract).toBeTruthy();
 expect(run.stage_one.label_ocr_views.length).toBeGreaterThan(0);
 expect(run.stage_one.label_ocr_views[0]).toMatchObject({text:'Norton 7500',status:'read',crop_box:{left:expect.any(Number)},view_sha256:expect.any(String)});
 const attempts=(await pool.query('SELECT * FROM recognition_provider_attempts WHERE run_id=$1',[run.id])).rows;
 expect(attempts).toHaveLength(fetch.mock.calls.length);
 expect(attempts.some(a=>a.outcome==='provider_error')).toBe(true);
 expect(attempts.every(a=>a.finished_at&&a.latency_ms>=0&&a.model_id&&a.provider&&a.raw_output)).toBe(true);
 expect(attempts.filter(a=>a.outcome==='response_received').every(a=>a.usage.input_tokens>0)).toBe(true);
 expect(attempts.every(a=>a.cost_usd===null&&a.cost_status==='unknown')).toBe(true);
});
