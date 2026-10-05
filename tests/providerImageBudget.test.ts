import {it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {randomBytes} from 'node:crypto';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn().mockResolvedValue({rows:[]})}}));
import {pool} from '../src/db/pool';
import {auditedFetch,recognitionAudit} from '../src/services/recognitionAudit';
import {prepareProviderImage,prepareProviderRequest,MAX_PROVIDER_REQUEST_BYTES} from '../src/services/recognitionImage';
it('bounds an oriented 12MP phone JPEG and persists the actual outgoing preprocessing',async()=>{
 const raw=randomBytes(4000*3000*3);
 const source=await sharp(raw,{raw:{width:4000,height:3000,channels:3}}).jpeg({quality:10}).withMetadata({orientation:6}).toBuffer();
 expect(source.length).toBeLessThan(2*1024*1024);
 const prepared=await prepareProviderImage(source);
 expect(prepared.metadata.width).toBeLessThan(prepared.metadata.height);
 expect(Math.max(prepared.metadata.width,prepared.metadata.height)).toBeLessThanOrEqual(2000);
 expect(prepared.data.length).toBeLessThanOrEqual(1_000_000);
 const payload={model:'fixture',messages:[{role:'user',content:Array.from({length:5},()=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data:source.toString('base64')}}))}]};
 const fetch=vi.fn(async(_url,init)=>{
  expect(Buffer.byteLength(String(init.body))).toBeLessThan(MAX_PROVIDER_REQUEST_BYTES);
  for(const block of JSON.parse(String(init.body)).messages[0].content){
   expect(block.source.media_type).toBe('image/jpeg');expect(block.source.data.length).toBeLessThan(10_000_000);
   const m=await sharp(Buffer.from(block.source.data,'base64')).metadata();expect(m.format).toBe('jpeg');expect(m.orientation).toBeUndefined();expect(m.height).toBeGreaterThan(m.width);
  }
  return Response.json({content:[{type:'text',text:'{}'}],usage:{input_tokens:1,output_tokens:1}});
 });vi.stubGlobal('fetch',fetch);
 try{
  await recognitionAudit.run({runId:'fixture-run',deadline:Date.now()+15000},()=>auditedFetch('https://provider.test',{body:JSON.stringify(payload)},'fixture'));
  const saved=vi.mocked(pool.query).mock.calls.find(c=>String(c[0]).includes('SET request_manifest'))!;
  const images=JSON.parse((saved[1] as any[])[1])[0].content;
  expect(images).toHaveLength(5);expect(images[0]).toMatchObject({operation:'exif_orient_resize_jpeg',source_orientation:6,source_width:4000,source_height:3000,media_type:'image/jpeg',quality:expect.any(Number),source_sha256:expect.any(String),sha256:expect.any(String)});
  expect(fetch).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals();}
},20000);
it('rejects oversized complete request bodies before a provider call',async()=>{
 await expect(prepareProviderRequest({messages:[{content:[{type:'text',text:'x'.repeat(MAX_PROVIDER_REQUEST_BYTES)}]}]})).rejects.toThrow('recognition_request_budget_exceeded');
});

// Exercise the actual readLabels -> crop -> OCR/provider path, not just dimensions.
vi.mock('tesseract.js',()=>({PSM:{SINGLE_LINE:'7',SPARSE_TEXT:'11'},createWorker:vi.fn(async()=>({setParameters:async()=>{},recognize:vi.fn(async()=>({data:{text:'',confidence:0}})),terminate:async()=>{}}))}));
import {createWorker} from 'tesseract.js';
import {readLabels,cropLabel,labelCropBox} from '../src/services/labelReading';
import {normalizeRecognitionImage,PROVIDER_LONG_EDGE} from '../src/services/recognitionImage';
import {createHash} from 'node:crypto';
it('keeps native 12MP label and model-line pixels for OCR before independently encoding provider views',async()=>{
 const raw=Buffer.alloc(4000*3000*3,255);
 // Fine, asymmetric marks are lost by whole-photo downsampling then enlargement.
 for(let y=600;y<720;y++)for(let x=400;x<1800;x++){
  const v=(Math.floor(x/2)+Math.floor(y/3))%2?20:235;
  raw.fill(v,(y*4000+x)*3,(y*4000+x)*3+3);
 }
 const original=await sharp(raw,{raw:{width:4000,height:3000,channels:3}}).png().toBuffer();
 const upright=await normalizeRecognitionImage(original);
 const region={photo_index:0,x:.08,y:.18,w:.4,h:.08,rotation:180,model_line_box:{x:.1,y:.2,w:.35,h:.04}};
 const crop=await cropLabel(upright,region);
 const box=labelCropBox({width:4000,height:3000},region);
 const exact=await sharp(upright).extract(box).png().toBuffer();
 expect(await sharp(crop).raw().toBuffer()).toEqual(await sharp(exact).rotate(180).raw().toBuffer());
 const line=await sharp(upright).extract({left:400,top:600,width:1400,height:120}).png().toBuffer();
 const expectedLine=await sharp(line).rotate(180).extend({top:10,bottom:10,left:10,right:10,background:'white'}).png().toBuffer();
 const outputs:any[]=[];
 vi.mocked(pool.query).mockClear();
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const body=JSON.parse(String(init.body));outputs.push(body);
  const prompt=body.messages[0].content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(' ');
  const value=prompt.includes('Locate identification markings')?{regions:[region]}:{reads:[{crop_index:0,text:''}]};
  return Response.json({content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:1,output_tokens:1}});
 }));
 process.env.ANTHROPIC_API_KEY='fixture-only';
 try{
  const evidence=await recognitionAudit.run({runId:'native-crop-run',deadline:Date.now()+25000},()=>readLabels([upright],'image/png'));
  const worker=await vi.mocked(createWorker).mock.results.at(-1)!.value;
  const ocrInputs=vi.mocked(worker.recognize).mock.calls.map(c=>c[0] as Buffer);
  const expectedPixels=await sharp(expectedLine).raw().toBuffer();
  let found=false;
  for(const input of ocrInputs)if((await sharp(input).raw().toBuffer()).equals(expectedPixels))found=true;
  expect(found).toBe(true);
  expect(evidence.ocr_views?.some(v=>v.scope==='model_line'&&v.transform.includes('rotate_180'))).toBe(true);
  const manifestCalls=vi.mocked(pool.query).mock.calls.filter(c=>String(c[0]).includes('SET request_manifest'));
  const images=manifestCalls.flatMap(c=>JSON.parse((c[1] as any[])[1]).flatMap((m:any)=>m.content)).filter((b:any)=>b.type==='image');
  const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  expect(images.some((b:any)=>b.source_sha256===digest(crop))).toBe(true);
  expect(images.find((b:any)=>b.source_sha256===digest(expectedLine))).toMatchObject({source_width:1420,source_height:140,width:1420,height:140});
  expect(images.every((b:any)=>Math.max(b.width,b.height)<=PROVIDER_LONG_EDGE)).toBe(true);
  // A reduced whole-photo copy cannot reproduce the high-frequency native marks.
  const reduced=await prepareProviderImage(upright);
  const wrong=await sharp(reduced.data).resize(4000,3000).extract({left:400,top:600,width:1400,height:120}).raw().toBuffer();
  expect(wrong.equals(await sharp(line).raw().toBuffer())).toBe(false);
 }finally{vi.unstubAllGlobals();delete process.env.ANTHROPIC_API_KEY;}
},30000);
