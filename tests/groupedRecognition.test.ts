import {it,expect,vi,beforeEach} from 'vitest';
import sharp from 'sharp';
const audit=vi.hoisted(()=>({fetch:vi.fn(),record:vi.fn(async()=>{})}));
vi.mock('../src/services/recognitionAudit',()=>({auditedFetch:audit.fetch,recordRecognitionEvidence:audit.record}));
import {readGroupedDevice,parseGroupedReply,GROUPED_MODEL,GROUPED_PROMPT} from '../src/services/groupedRecognition';
import {catalogIdentityReview,applyCatalogIdentityProposal} from '../src/services/catalogIdentityReview';
import {prepareProviderImage,prepareProviderRequest} from '../src/services/recognitionImage';
const envelope=(reads:any[],extra:any={})=>({model:GROUPED_MODEL,stop_reason:'end_turn',content:[{type:'thinking',thinking:'',signature:'fixture'},{type:'text',text:JSON.stringify({component_class:'EXIT_DEVICE',manufacturer:'PDQ',series:'6200',model:'6200R',reads,...extra})}]});
const marks=()=>[{photo_index:1,kind:'brand_mark',text:'PDQ',legibility:'clear',all_characters_visible:true,target_device:true},{photo_index:2,kind:'product_label',text:'Model 6200R',legibility:'clear',all_characters_visible:true,target_device:true}];
beforeEach(()=>{audit.fetch.mockReset();audit.record.mockClear();});
it('combines two literal markings on different views into one catalog-supported identity without OCR',()=>{
 const {labels,result}=parseGroupedReply(envelope(marks()),3);
 const review=catalogIdentityReview(labels,result);
 const final=applyCatalogIdentityProposal(result,review);
 expect(final).toMatchObject({manufacturer:'PDQ',series:'6200',model:'6200R',component_class:'EXIT_DEVICE'});
 expect(final.identity_evidence.map((e:any)=>e.photo_index)).toEqual([2,1]);
 expect(final.confidence.model).toBeNull();expect(labels.reads.every(r=>r.ocr_status==='not_attempted')).toBe(true);
});
it('does not promote an AI identity claim without literal photo evidence',()=>{
 const {labels,result}=parseGroupedReply(envelope([]),3);
 expect(result.grouped_identity_claim.model).toBe('6200R');
 expect(applyCatalogIdentityProposal(result,catalogIdentityReview(labels,result)).model).toBeNull();
});
it.each(['true','exit device',null])('does not coerce invalid device association %s',target_device=>{
 const reads=marks();reads[0].target_device=target_device as any;
 const {labels,result}=parseGroupedReply(envelope(reads),3);
 expect(catalogIdentityReview(labels,result).candidates).toHaveLength(0);
 expect(labels.reads[1].vision_text).toBe('Model 6200R');
});
it('retains valid photo entries when one entry has an invalid photo index',()=>{
 const {labels,result}=parseGroupedReply(envelope([...marks(),{...marks()[0],photo_index:9}]),3);
 expect(labels.status).toBe('partial');expect(catalogIdentityReview(labels,result).candidates).toHaveLength(1);
});
it('does not use partial, clipped or other-device marks to establish a brand',()=>{
 for(const patch of [{all_characters_visible:false},{target_device:false},{legibility:'partial'},{text:'P?Q'}]){
  const reads=marks();Object.assign(reads[0],patch);const {labels,result}=parseGroupedReply(envelope(reads),3);
  expect(catalogIdentityReview(labels,result).candidates).toHaveLength(0);
 }
});
it('surfaces a conflicting maker and keeps catalog identity despite classifier type disagreement',()=>{
 const {labels,result}=parseGroupedReply(envelope(marks(),{component_class:'DOOR_CLOSER'}),3);
 const review=catalogIdentityReview(labels,result);expect(review.status).toBe('TYPE_CONFLICT');
 expect(applyCatalogIdentityProposal(result,review).model).toBe('6200R');
 const conflict=parseGroupedReply(envelope([...marks(),{...marks()[0],photo_index:0,text:'DORMA'}]),3);
 expect(catalogIdentityReview(conflict.labels,conflict.result).status).toBe('CONFLICT');
});
it('rejects refusals and token-truncated replies even with parseable text',()=>{
 expect(()=>parseGroupedReply({...envelope(marks()),stop_reason:'max_tokens'},3)).toThrow();
 expect(()=>parseGroupedReply({...envelope(marks()),stop_reason:'refusal'},3)).toThrow();
});
it('sends all original-derived views in ONE medium-effort request with no expected identity',async()=>{
 const image=await sharp({create:{width:2000,height:1500,channels:3,background:'white'}}).jpeg().toBuffer();
 audit.fetch.mockResolvedValue(Response.json(envelope(marks())));
 const value=await readGroupedDevice([image,image,image],Date.now()+45000);
 expect(audit.fetch).toHaveBeenCalledTimes(1);
 const request=JSON.parse(audit.fetch.mock.calls[0][1].body);
 expect(request.model).toBe(GROUPED_MODEL);expect(request.output_config).toEqual({effort:'medium'});
 expect(request.temperature).toBeUndefined();expect(request.thinking).toBeUndefined();
 expect(request.messages[0].content.filter((b:any)=>b.type==='image')).toHaveLength(3);
 expect(GROUPED_PROMPT).not.toMatch(/PDQ|6200|DORMA/);
 expect(value.labels.reads).toHaveLength(2);
 const prepared=await prepareProviderRequest(request);
 expect(prepared.manifest[0].content.filter((b:any)=>b.type==='image').every((b:any)=>b.width===2000&&b.height===1500&&b.operation==='verified_jpeg_passthrough')).toBe(true);
});
it('uses the Opus resolution and patch ceiling without lowering legacy Sonnet limits',async()=>{
 const image=await sharp({create:{width:4032,height:3024,channels:3,background:'white'}}).jpeg().toBuffer();
 const high=await prepareProviderImage(image,3_000_000,GROUPED_MODEL);
 expect(Math.max(high.metadata.width,high.metadata.height)).toBeGreaterThan(1568);
 expect(Math.max(high.metadata.width,high.metadata.height)).toBeLessThanOrEqual(2576);
 expect(Math.ceil(high.metadata.width/28)*Math.ceil(high.metadata.height/28)).toBeLessThanOrEqual(4784);
 const legacy=await prepareProviderImage(image);expect(Math.max(legacy.metadata.width,legacy.metadata.height)).toBeLessThanOrEqual(1568);
});
