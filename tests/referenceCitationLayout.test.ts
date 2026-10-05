// Unit boundary: provider/audit integration is covered by recognitionAuditApi and recognitionFixes.
vi.mock('../src/services/recognitionAudit',()=>({auditedFetch:(url:string,init:RequestInit)=>fetch(url,init),recordRecognitionEvidence:vi.fn()}));
import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn()}}));
import {sourceQuote,validateCitations,compareWithReferences,type ReferencePage} from '../src/services/referenceEvidence';
const text='Heavy-Duty Double Lever Arm with Extra Smooth Action\n     Full Feature Multi-Size Commercial Door Closer for Use In Office\nStandard Packaging includes Full Plastic Cover with Sex Bolts\n     and Screws. (Metal Optional)';
const page:ReferencePage={page_id:'source#p1',doc_sha256:'source',page_no:1,text,text_sha256:'text-hash',brand:'Example',title:'Fixture',image_key:null,models:['fixture']};
const citation={page_id:page.page_id,doc_sha256:page.doc_sha256,page_no:1,quote:'Standard Packaging includes Full Plastic Cover with Sex Bolts and Screws. (Metal Optional)'};
describe('layout-safe source citations',()=>{
 it('accepts wrapped text and returns the exact original source span',()=>{
  const result=validateCitations([citation],[page]);
  expect(result.rejected).toEqual([]);
  expect(result.accepted[0].quote).toContain('Bolts\n     and');
  expect(text.includes(result.accepted[0].quote)).toBe(true);
 });
 it('preserves punctuation, case, numbers and intervening column content',()=>{
  for(const quote of ['Metal optional','Metal, Optional','Full Metal Cover','(Metal Optional!)'])expect(sourceQuote(text,quote)).toBeNull();
  expect(sourceQuote('Size 1 thru 6','Size 1 thru 5')).toBeNull();
  expect(sourceQuote('Closing Speed\n DOOR WIDTH 36”\n Regulating Valves','Closing Speed Regulating Valves')).toBeNull();
 });
 it('rejects mismatched page identity, malformed objects and empty quotes',()=>{
  const bad=[{...citation,doc_sha256:'other'},{...citation,page_no:2},{...citation,page_id:'other'},null,'source#p1 quote',{...citation,quote:'   '}];
  expect(validateCitations(bad,[page])).toEqual({accepted:[],rejected:bad});
 });
 it('escapes regular expression syntax in source quotations',()=>{
  expect(sourceQuote('A. (size 1 thru 6)\n + adjustment','A. (size 1 thru 6) + adjustment')).toBe('A. (size 1 thru 6)\n + adjustment');
  expect(sourceQuote('Ax size 1 thru 6 + adjustment','A. (size 1 thru 6) + adjustment')).toBeNull();
 });
 it('provides compact text and explicit structured citation instructions to the provider',async()=>{
  const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({content:[{type:'text',text:'{"candidates":[],"citations":[],"unresolved":[]}'}]})});
  vi.stubGlobal('fetch',fetch);
  try{
   await compareWithReferences({images:[],media_type:'image/jpeg',stage_one:{},attributes:{},pages:[page],conflicts:[]});
   const body=JSON.parse(fetch.mock.calls[0][1].body);
   const prompt=body.messages[0].content[0].text;
   expect(prompt).toContain('never a string');
   const payload=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
   expect(payload.pages[0].text).toBe(text.replace(/\s+/g,' ').trim());
   expect(page.text).toBe(text);
  }finally{vi.unstubAllGlobals();}
 });
});

it.each([[401,'reference_provider_authentication_failed'],[429,'reference_provider_rate_limited'],[503,'reference_provider_unavailable'],[400,'reference_provider_request_rejected']])('reports safe provider failure %s without exposing its body',async(status,code)=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status,json:async()=>({private:'credential detail'})}));
 try{await expect(compareWithReferences({images:[],media_type:'image/jpeg',stage_one:{},attributes:{},pages:[page],conflicts:[]})).rejects.toThrow(code);}finally{vi.unstubAllGlobals();}
});
it.each([['max_tokens','{}','reference_response_truncated'],['end_turn','broken JSON','reference_response_invalid']])('separates truncated responses from invalid JSON',async(stop,text,code)=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({stop_reason:stop,content:[{type:'text',text}]})}));
 try{await expect(compareWithReferences({images:[],media_type:'image/jpeg',stage_one:{},attributes:{},pages:[page],conflicts:[]})).rejects.toThrow(code);}finally{vi.unstubAllGlobals();}
});
it('retains the timeout category without provider exception text',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Object.assign(Error('private transport detail'),{name:'TimeoutError'})));
 try{await expect(compareWithReferences({images:[],media_type:'image/jpeg',stage_one:{},attributes:{},pages:[page],conflicts:[]})).rejects.toThrow('reference_comparison_timeout');}finally{vi.unstubAllGlobals();}
});

it('bounds source excerpts and output, excludes typed identity and product-specific prompt answers, and retains provider usage',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({usage:{input_tokens:123,output_tokens:45},content:[{type:'text',text:'{"candidates":[],"citations":[],"unresolved":[]}'}]})});
 vi.stubGlobal('fetch',fetch);
 try{
 const result=await compareWithReferences({images:[],media_type:'image/jpeg',stage_one:{component_class:'DOOR_CLOSER',private_debug:'not-for-provider'},attributes:{model:'EXPECTED-ANSWER'},pages:[{...page,text:'source '.repeat(5000)}],conflicts:[]});
 const body=JSON.parse(fetch.mock.calls[0][1].body),prompt=body.messages[0].content[0].text,payload=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
 expect(body.max_tokens).toBe(1400);expect(payload.pages[0].text.length).toBe(2100);expect(payload.pages[0].excerpt_only).toBe(true);
 expect(prompt).not.toMatch(/EXPECTED-ANSWER|not-for-provider|4040XP|4041|LCN/);
 expect(result.processing.provider_usage).toEqual({input_tokens:123,output_tokens:45});
 expect(result.processing.excerpted_pages).toBe(1);
 }finally{vi.unstubAllGlobals();}
});

it('does not count a removed cover as contradictory identity evidence and retains actual feature differences',async()=>{
 const {sanitizeReferenceComparison}=await import('../src/services/referenceEvidence');
 const absent={observation:'No snap-fit cover visible on body; reference describes patented snap-fit cover feature',citation};
 const visible={observation:'Installed cover is curved; reference cover is rectangular',citation};
 const original={candidates:[{manufacturer:'Example',model:'QA',contradicting_features:[absent,visible,{observation:'Arm mounting differs',citation}]}]};
 const result=sanitizeReferenceComparison(original);
 expect(result.candidates[0].contradicting_features).toEqual([visible,{observation:'Arm mounting differs',citation}]);
 expect(result.cover_comparison).toBe('unavailable_without_installed_cover');
 expect(result.reasoning_adjustments[0].feature).toEqual(absent);
 expect(original.candidates[0].contradicting_features).toHaveLength(3);
});

it('keeps classifier-only markings out of comparison evidence and rejects their conflicts',async()=>{
 const {applyLabelEvidence}=await import('../src/services/labelReading');
 const {comparisonPayload,sanitizeReferenceComparison}=await import('../src/services/referenceEvidence');
 const stage=applyLabelEvidence({visible_text:['RYOBI'],evidence:[{supports:'visible_text',observation:'RYOBI label'},{supports:'arm_type',observation:'scissor arm'}]}, {version:'test',status:'completed',reads:[],limiting_factor:null});
 expect(stage.visible_text).toEqual([]);
 expect(stage.classifier_visible_text).toEqual(['RYOBI']);
 expect(stage.classifier_text_evidence).toHaveLength(1);
 const payload=comparisonPayload({stage_one:stage,pages:[],conflicts:[]});
 expect(JSON.stringify(payload)).not.toContain('RYOBI');
 expect(JSON.stringify(payload)).toContain('scissor arm');
 const result=sanitizeReferenceComparison({candidates:[{model:'4040XP',contradicting_features:[{observation:'Visible RYOBI differs from LCN'},{observation:'Mounting pattern differs'}]}],unresolved:['RYOBI text conflicts','Model is unconfirmed']},stage);
 expect(result.candidates[0].contradicting_features).toEqual([]);
 expect(result.unresolved).toEqual(['Model is unconfirmed']);
 expect(result.reasoning_adjustments).toHaveLength(3);
 expect(result.cover_comparison).toBeUndefined();
});
it('preserves a corroborated marking conflict without treating repeated AI views as confirmation',async()=>{
 const {applyLabelEvidence}=await import('../src/services/labelReading');
 const {sanitizeReferenceComparison}=await import('../src/services/referenceEvidence');
 const read={region:{photo_index:0,x:0,y:0,w:1,h:1,rotation:0},ocr_text:'RYOBI',ocr_confidence:90,vision_text:'RYOBI',agreed_markings:['RYOBI'],status:'agreement' as const};
 const stage=applyLabelEvidence({visible_text:['RYOBI']},{version:'test',status:'completed',reads:[read],limiting_factor:null});
 const comparison={candidates:[{contradicting_features:[{observation:'RYOBI differs from LCN'}]}]};
 expect(sanitizeReferenceComparison(comparison,stage).candidates[0].contradicting_features).toHaveLength(1);
 const unconfirmed=applyLabelEvidence({visible_text:['RYOBI']},{version:'test',status:'completed',reads:[{...read,ocr_text:'',agreed_markings:[]},{...read,ocr_text:'',agreed_markings:[]}],limiting_factor:null});
 expect(unconfirmed.visible_text).toEqual([]);
});
