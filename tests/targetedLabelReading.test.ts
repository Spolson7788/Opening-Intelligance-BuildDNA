import {it,expect,vi,beforeEach} from 'vitest';
import sharp from 'sharp';
const audit=vi.hoisted(()=>({fetch:vi.fn(),record:vi.fn(async()=>{})}));
vi.mock('../src/services/recognitionAudit',()=>({auditedFetch:audit.fetch,recordRecognitionEvidence:audit.record,recognitionAuditStopped:()=>false}));
vi.mock('tesseract.js',()=>({PSM:{SINGLE_LINE:'7',SPARSE_TEXT:'11'},createWorker:vi.fn(async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:'1234R',confidence:90}}),terminate:async()=>{}}))}));
import {normalizeRegions,readTargetedLabels,readFocusedMarkings} from '../src/services/labelReading';
import {targetedLabelPlan,targetedReaderCanStart,targetedLabelDeadline} from '../src/services/targetedLabelPlan';
it('original preparation leaves reader headroom and classifier time within the run deadline',()=>{
 const deadline=targetedLabelDeadline(0,12_211);
 expect(deadline).toBe(43_000);
 expect(targetedReaderCanStart(deadline,12_211+8_000)).toBe(true);
 expect(52_000-deadline).toBeGreaterThanOrEqual(9_000);
 expect(targetedLabelDeadline(0,1_000)).toBe(33_000);
});
const envelope=(value:unknown)=>Response.json({content:[{type:'text',text:JSON.stringify(value)}]});
beforeEach(()=>{audit.fetch.mockReset();audit.record.mockClear();});
it('starts the logo while the sticker is still pending and checkpoints their evidence independently',async()=>{
 const source=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer();
 let finishSticker!:(value:Response)=>void;
 const sticker=new Promise<Response>(resolve=>{finishSticker=resolve;});
 let logoStarted!:(value:void)=>void;
 const logo=new Promise<void>(resolve=>{logoStarted=resolve;});
 audit.fetch.mockImplementation(async(_url,init,stage)=>{
  if(stage==='label_locator')return envelope({regions:[{photo_index:0,x:0,y:0,w:.4,h:.4,rotation:0,kind:'product_label'},{photo_index:1,x:0,y:0,w:.4,h:.4,rotation:0,kind:'brand_mark'}]});
  const content=JSON.parse(init.body).messages[0].content;
  expect(content.filter((c:any)=>c.type==='image')).toHaveLength(3);
  if(content[0].text.includes('crop 0'))return sticker;
  logoStarted();return envelope({reads:[{crop_index:1,text:'Visible maker',legibility:'clear'}]});
 });
 const result=readTargetedLabels([source,source],'image/png',Date.now()+32000);
 await logo;
 finishSticker(envelope({reads:[{crop_index:0,text:'1234R',legibility:'clear'}]}));
 const value=await result;
 expect(value.reads.map(r=>r.vision_text)).toEqual(['1234R','Visible maker']);
 expect(audit.record.mock.calls.map(c=>c[0])).toEqual(expect.arrayContaining(['targeted_label_read_0','targeted_label_read_1']));
 expect(value.reads.every(r=>r.ocr_status==='not_attempted'&&r.agreed_markings.length===0)).toBe(true);
});
it('separates cast maker marks from model-line boxes and prioritizes physical labels from other views',()=>{
 const regions=normalizeRegions([{photo_index:0,x:.1,y:.1,w:.5,h:.5,rotation:90,kind:'brand_mark',model_line_box:{x:.2,y:.2,w:.2,h:.1}},{photo_index:1,x:.2,y:.2,w:.4,h:.4,rotation:0,kind:'product_label',model_line_box:{x:.25,y:.25,w:.2,h:.1}}],2);
 expect(regions[0].model_line_box).toBeUndefined();expect(regions[1].model_line_box).toBeDefined();
 expect(targetedLabelPlan(regions).map(r=>r.photo_index)).toEqual([1,0]);
 expect(targetedLabelPlan([...regions, {...regions[1],photo_index:2},{...regions[1],photo_index:3}]).map(r=>r.photo_index)).toEqual([1,0,2]);
 expect(targetedReaderCanStart(20_000,13_300)).toBe(false);expect(targetedReaderCanStart(20_000,8_000)).toBe(true);
});
it('sends one native crop per reader call and retains a completed transcription if a later crop times out',async()=>{
 const source=await sharp({create:{width:400,height:300,channels:3,background:'white'}}).png().toBuffer();
 audit.fetch.mockImplementation(async(_url,init,stage)=>{
  const request=JSON.parse(init.body);const content=request.messages[0].content;
  if(stage==='label_locator')return envelope({regions:[{photo_index:0,x:.1,y:.1,w:.4,h:.4,rotation:0,kind:'brand_mark'},{photo_index:1,x:.1,y:.1,w:.5,h:.5,rotation:0,kind:'product_label'}]});
  expect(stage).toBe('label_reader');expect(content.filter((b:any)=>b.type==='image')).toHaveLength(3);
  if(content[0].text.includes('crop 0'))return envelope({reads:[{crop_index:0,text:'1234R',legibility:'clear'}]});
  throw new DOMException('late reader','TimeoutError');
 });
 const result=await readTargetedLabels([source,source],'image/png',Date.now()+32000);
 expect(result.status).toBe('partial');expect(result.reads[0]).toMatchObject({vision_text:'1234R',region:{photo_index:1,kind:'product_label'}});
 expect(result.reads[1].region.kind).toBe('brand_mark');expect(result.reads[1].agreed_markings).toEqual([]);
 expect(result.limiting_factor).toBe('label_timeout');expect(result.stage_outcomes?.label_locator.status).toBe('succeeded');
 expect(audit.record.mock.calls.some(([key,value])=>key==='targeted_label_reads'&&value[0].vision_text==='1234R')).toBe(true);
});
it('does not issue a paid reader call with only the baseline 6.7 second headroom',async()=>{
 const source=await sharp({create:{width:80,height:60,channels:3,background:'white'}}).png().toBuffer();
 audit.fetch.mockResolvedValue(envelope({regions:[{photo_index:0,x:0,y:0,w:1,h:1,rotation:0,kind:'product_label'}]}));
 const result=await readTargetedLabels([source],'image/png',Date.now()+6700);
 expect(audit.fetch.mock.calls.map(c=>c[2])).toEqual(['label_locator']);
 expect(result.reads).toEqual([]);expect(result.limiting_factor).toBe('reader_budget_insufficient');
});
it('keeps a missing crop reply distinct from an explicitly unreadable crop',async()=>{
 const source=await sharp({create:{width:80,height:60,channels:3,background:'white'}}).png().toBuffer();
 audit.fetch.mockImplementation(async(_url,_init,stage)=>stage==='label_locator'?envelope({regions:[{photo_index:0,x:0,y:0,w:1,h:1,rotation:0,kind:'product_label'}]}):envelope({reads:[]}));
 const result=await readTargetedLabels([source],'image/png',Date.now()+32000);
 expect(result.status).toBe('partial');expect(result.reads[0].vision_status).toBe('not_returned');expect(result.limiting_factor).toBe('label_partial_reads');
});

it('saves a locator-only plan without spending any reader call',async()=>{
 const source=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer();
 audit.fetch.mockResolvedValue(envelope({regions:[{photo_index:0,x:.1,y:.1,w:.5,h:.5,kind:'product_label',rotation:0}]}));
 const result=await readTargetedLabels([source],'image/png',Date.now()+31000,{}, {mode:'locate',locatorMs:30000});
 expect(result.planned_regions).toHaveLength(1);expect(result.reads).toEqual([]);expect(audit.fetch).toHaveBeenCalledTimes(1);expect(audit.fetch.mock.calls[0][2]).toBe('label_locator');
});
it('uses persisted regions in a fresh reader stage without calling the locator again',async()=>{
 const source=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer();
 audit.fetch.mockResolvedValue(envelope({reads:[{crop_index:0,text:'1234R',legibility:'clear'}]}));
 const onRead=vi.fn();
 const result=await readTargetedLabels([source],'image/png',Date.now()+33000,{}, {mode:'read',regions:[{photo_index:0,x:.1,y:.1,w:.5,h:.5,rotation:0,kind:'product_label'}],readerMs:32000,onRead});
 expect(onRead).toHaveBeenCalledWith(0,expect.objectContaining({vision_text:'1234R'}));
 expect(result.reads[0].vision_text).toBe('1234R');expect(audit.fetch).toHaveBeenCalledTimes(1);expect(audit.fetch.mock.calls[0][2]).toBe('label_reader');
});

it('blindly verifies focused native pixels in four orientations and keeps the prior rejected guess',async()=>{
 const source=await sharp(Buffer.from('<svg width="400" height="400"><rect width="400" height="400" fill="white"/><text x="100" y="170" font-size="60" fill="black">ABC</text></svg>')).png().toBuffer();
 const prior:any={version:'oi-targeted-label-reading-3',status:'completed',limiting_factor:null,reads:[{region:{photo_index:0,x:.25,y:.25,w:.4,h:.2,rotation:270,kind:'brand_mark'},provenance:{source:'native_tile',target_device:true,location_validated:false,box:{x:.25,y:.25,w:.4,h:.2}},vision_text:'EarlierWrongMaker',vision_status:'read',ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed'}]};
 audit.fetch.mockImplementation(async(_url,init,stage)=>{
  expect(stage).toBe('label_reread');const content=JSON.parse(init.body).messages[0].content;
  expect(content.filter((c:any)=>c.type==='image')).toHaveLength(5);
  const text=content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join(' ');expect(text).not.toContain('EarlierWrongMaker');expect(text).not.toContain('6200R');expect(text).toContain('rotation 90');expect(text).toContain('view_index 1');expect(text).toContain('rotation 270');
  return envelope({reads:[{crop_index:0,text:'ABC',legibility:'clear',source:'focused_view',view_index:0,all_characters_visible:true,target_device:true}]});
 });
 const result=await readFocusedMarkings([source],prior,Date.now()+32000);
 expect(result.reads).toHaveLength(2);expect(result.reads[0].vision_text).toBe('EarlierWrongMaker');expect(result.reads[0].provenance?.location_validated).toBe(false);expect(result.reads[1].vision_text).toBe('ABC');expect(result.reads[1].provenance?.source).toBe('focused_view');expect(result.reads[1].provenance?.location_validated).toBe(true);expect(audit.fetch).toHaveBeenCalledTimes(1);
});
it('retains prior evidence if the focused verification request fails',async()=>{
 const source=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer();
 const prior:any={version:'oi-targeted-label-reading-3',status:'completed',limiting_factor:null,reads:[{region:{photo_index:0,x:.2,y:.2,w:.2,h:.2,rotation:0,kind:'brand_mark'},provenance:{source:'native_tile',target_device:true,location_validated:true,box:{x:.2,y:.2,w:.2,h:.2}},vision_text:'ABC',vision_status:'read',ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed'}]};
 audit.fetch.mockRejectedValue(new DOMException('timeout','TimeoutError'));const result=await readFocusedMarkings([source],prior,Date.now()+32000);expect(result.reads).toEqual(prior.reads);expect(result.limiting_factor).toBe('label_timeout');expect(result.stage_outcomes?.label_reread.status).toBe('failed');
});
