import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import sharp from 'sharp';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn().mockResolvedValue({rows:[]})}}));
import {pool} from '../src/db/pool';
import {recognitionAudit,auditedFetch} from '../src/services/recognitionAudit';
import {normalizeRecognitionImage} from '../src/services/recognitionImage';
import {labelCandidates,cropLabel,readLabels,type LabelRead} from '../src/services/labelReading';
import {identityValues} from '../src/services/hardwareIdentity';
import {partialCatalogCandidates} from '../src/services/partialMarkings';
import {withinRecognitionBudget} from '../src/services/recognitionDeadline';
const read=(vision_text:string):LabelRead=>({region:{photo_index:0,x:0,y:0,w:1,h:1,rotation:0},vision_text,ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed'});
beforeEach(()=>{vi.mocked(pool.query).mockReset().mockResolvedValue({rows:[]} as any);});
afterEach(()=>{vi.unstubAllGlobals();delete process.env.OI_PROVIDER_INPUT_USD_PER_MILLION;delete process.env.OI_PROVIDER_OUTPUT_USD_PER_MILLION;});
it.each([{manufacturer:'Cal-Royal',model:'CR441'},{manufacturer:'Norton',model:'7500'},{manufacturer:'Sargent',model:'281'},{manufacturer:'LCN',model:'1260'},{manufacturer:'LCN',model:'4040XP'}])('matches $manufacturer $model only through supplied catalog data',entry=>{
 expect(labelCandidates([read(entry.model)])).toEqual([]);
 expect(labelCandidates([read(entry.model)],[entry])[0]).toMatchObject({...entry,manufacturer_basis:'catalog_model_match'});
 expect(partialCatalogCandidates([read(entry.model.slice(0,-1)+'?')],[entry]).every(c=>c.model===null)).toBe(true);
});
it('never promotes a sole incomplete match into a model',()=>{
 const [candidate]=partialCatalogCandidates([read('4040X?')],[{manufacturer:'LCN',model:'4040XP',series:'4040'}]);
 expect(candidate.model).toBeNull();expect(candidate.transcribed_marking).toBe('4040X?');
});
it('derives value producer from server evidence and cannot label a technician value as AI',()=>{
 const input:any={manufacturer:'Norton',model_number:'7500',identity_source:'photo_suggestion',identity_acknowledged:true,recognition_run_id:'run'};
 expect(identityValues(input,'actor',{suggestion:{manufacturer:'LCN',model:'4040XP'}})).toMatchObject({identity_source:'technician_identified',identity_value_producer:'technician'});
 expect(identityValues(input,'actor',{suggestion:{manufacturer:'Norton',model:'7500'}})).toMatchObject({identity_source:'photo_suggestion',identity_value_producer:'AI'});
 expect(identityValues(input,'actor',{stage_one:{label_reading:{candidates:[{manufacturer:'Norton',model:'7500',manufacturer_basis:'catalog_model_match'}]}}})).toMatchObject({identity_value_producer:'catalog'});
});
it.each([2,3,4,5,6,7,8])('normalizes EXIF orientation %s before source-coordinate cropping even below 2MB',async orientation=>{
 const raw=Buffer.from(Array.from({length:80*40*3},(_,i)=>(i*17)%255));
 const source=await sharp(raw,{raw:{width:80,height:40,channels:3}}).jpeg().withMetadata({orientation}).toBuffer();
 expect(source.length).toBeLessThan(2*1024*1024);
 const upright=await normalizeRecognitionImage(source);
 const expected=await sharp(source).autoOrient().removeAlpha().png().toBuffer();
 expect(await sharp(upright).raw().toBuffer()).toEqual(await sharp(expected).raw().toBuffer());
 const region={photo_index:0,x:.1,y:.2,w:.4,h:.5,rotation:180};
 expect(await cropLabel(upright,region)).toEqual(await cropLabel(expected,region));
 expect((await sharp(upright).metadata()).orientation).toBeUndefined();
});
const invoke=(deadline=Date.now()+2000)=>recognitionAudit.run({runId:'run',deadline},()=>auditedFetch('https://provider.test',{method:'POST',body:JSON.stringify({model:'fixture',messages:[]})},'label'));
it('records raw responses, token usage, cost and latency with a pre-existing run',async()=>{
 const raw=JSON.stringify({content:[{type:'text',text:'{"reads":[]}'}],usage:{input_tokens:100,output_tokens:20}});
 process.env.OI_PROVIDER_INPUT_USD_PER_MILLION='3';process.env.OI_PROVIDER_OUTPUT_USD_PER_MILLION='15';
 const fetch=vi.fn(async()=>{expect(vi.mocked(pool.query).mock.calls[0][0]).toContain('INSERT INTO recognition_provider_attempts');return new Response(raw);});vi.stubGlobal('fetch',fetch);
 expect(await (await invoke()).text()).toBe(raw);
 const values=vi.mocked(pool.query).mock.calls.find(c=>String(c[0]).includes('raw_output'))![1] as any[];
 expect(values[1]).toBe('response_received');expect(values[4]).toBeCloseTo(.0006);expect(values[5]).toBe('estimated');expect(values[6]).toBe(raw);
});
it('aborts the underlying provider call and persists timeout with unknown usage and cost',async()=>{
 let aborted=false;
 vi.stubGlobal('fetch',vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason);},{once:true}))));
 await expect(invoke(Date.now()+30)).rejects.toThrow();expect(aborted).toBe(true);
 expect(vi.mocked(pool.query).mock.calls.filter(c=>String(c[0]).includes('SET outcome'))[0][1]?.[1]).toBe('timeout');
});
it('records transport and provider failures without inventing token counts',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValueOnce(new Response('{"error":"unavailable"}',{status:503})));
 await expect(invoke()).rejects.toThrow('network');expect(vi.mocked(pool.query).mock.calls.filter(c=>String(c[0]).includes('SET outcome'))[0][1]?.[1]).toBe('error');
 await invoke();expect(vi.mocked(pool.query).mock.calls.filter(c=>String(c[0]).includes('SET outcome'))[1][1]?.[1]).toBe('provider_error');expect(vi.mocked(pool.query).mock.calls.filter(c=>String(c[0]).includes('SET outcome'))[1][1]?.[4]).toBeNull();
});
it('makes no paid call when durable attempt creation fails',async()=>{
 vi.mocked(pool.query).mockRejectedValueOnce(Error('audit unavailable'));const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await expect(invoke()).rejects.toThrow('audit unavailable');expect(fetch).not.toHaveBeenCalled();
});
it('outer stage budget signals cancellation rather than only stopping the wait',async()=>{
 let aborted=false;
 const result=await withinRecognitionBudget(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve('aborted');})),Date.now()+10,()=> 'fallback');
 expect(aborted).toBe(true);expect(['fallback','aborted']).toContain(result);
});

it('matches spaced model markings without completing unknown suffixes',()=>{
 const catalog=[{manufacturer:'LCN',model:'4041 DA'}];
 expect(labelCandidates([read('4041DA')],catalog)[0].model).toBe('4041 DA');
 expect(labelCandidates([read('4041 D?')],catalog)).toEqual([]);
});
it('preserves AI provenance when a technician acknowledges a shadow suggestion',()=>{
 expect(identityValues({manufacturer:'Norton',model_number:'7500',identity_source:'photo_suggestion',identity_acknowledged:true},'actor',{stage_one:{shadow_mode:true},suggestion:{manufacturer:'Norton',model:'7500'}})).toMatchObject({identity_source:'photo_suggestion',identity_value_producer:'AI'});
});

it.each([{input_tokens:10},{output_tokens:10},{input_tokens:null,output_tokens:10},{input_tokens:'10',output_tokens:2},{input_tokens:-1,output_tokens:2},{input_tokens:1,output_tokens:1.2}])('records unknown cost for incomplete or invalid usage %j',async usage=>{
 process.env.OI_PROVIDER_INPUT_USD_PER_MILLION='3';process.env.OI_PROVIDER_OUTPUT_USD_PER_MILLION='15';
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({content:[{type:'text',text:'{}'}],usage})));
 await invoke();
 const values=vi.mocked(pool.query).mock.calls.find(c=>String(c[0]).includes('raw_output'))![1] as any[];
 expect(values[4]).toBeNull();expect(values[5]).toBe('unknown');expect(JSON.parse(values[3])).toEqual(usage);
});
it('refuses to call a provider without an audit context',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await expect(auditedFetch('https://provider.test',{body:'{}'},'label')).rejects.toThrow('recognition_audit_context_required');
 expect(fetch).not.toHaveBeenCalled();expect(pool.query).not.toHaveBeenCalled();
});

it('rejects tiny numeric catalog matches and numeric fragments',async()=>{
 const {catalogTranscription}=await import('../src/services/catalogMarking');
 for(const [text,model] of [['SIZE 1-98','98'],['1','1'],['SIZE 1-980','980']])expect(catalogTranscription(text,model)).toBeNull();
 expect(catalogTranscription('CR 441','CR441')).toBe('CR 441');
 expect(catalogTranscription('7500','7500')).toBe('7500');
});
it('quarantines uncorroborated classifier identity before retrieval and display',async()=>{
 const {conservativeSuggestion,candidates,resolvePartialMarkings}=await import('../src/services/referenceEvidence');
 const {applyLabelEvidence}=await import('../src/services/labelReading');
 const stage=applyLabelEvidence({manufacturer:'RYOBI',series:'2000',model:'2001',visible_text:['RYOBI'],confidence:{}},{version:'test',status:'completed',reads:[],limiting_factor:null});
 const safe=conservativeSuggestion(stage,null);
 expect(safe).toMatchObject({manufacturer:null,series:null,model:null});expect(candidates(safe)).toEqual([]);
 expect(safe.photograph_identity.manufacturer).toBe('RYOBI');
 vi.mocked(pool.query).mockResolvedValueOnce({rows:[{manufacturer:'LCN',model:'4040XP'}]} as any);
 const matches=await resolvePartialMarkings({version:'test',status:'completed',reads:[read('4040XP')],limiting_factor:null});
 expect(matches[0].manufacturer).toBe('LCN');
 expect(vi.mocked(pool.query).mock.calls.at(-1)?.[1]).toEqual(['']);
});
it.each([undefined,'unknown','technician_identified','photo_suggestion'])('requires acknowledgement for established identity from %s',async source=>{
 const {identityInputError}=await import('../src/services/hardwareIdentity');
 expect(identityInputError({identity_status:'established',identity_source:source as any,manufacturer:'LCN',model_number:'4040XP'})).toBe('identity_acknowledgment_required');
});

it('validates label replies and preserves a string-index transcription without repairing characters',async()=>{
 const {parseLabelResponse}=await import('../src/services/labelResponse');
 const body=(v:any)=>({content:[{type:'text',text:JSON.stringify(v)}]});
 expect(parseLabelResponse(body({reads:[{crop_index:'0',text:'4040XP'}]}),'label_reader',1).reads[0]).toEqual({crop_index:0,text:'4040XP'});
 expect(()=>parseLabelResponse(body({}),'label_reader',1)).toThrow('label_invalid_reads');
 for(const value of [{reads:[]},{reads:[{crop_index:0,text:null}]},{reads:[{crop_index:0,text:''},{crop_index:0,text:'4040XP'}]}])expect(parseLabelResponse(body(value),'label_reader',1)).toMatchObject({reads:[],validation:{status:'partial'}});
 expect(()=>parseLabelResponse({stop_reason:'refusal'},'label_locator',1)).toThrow('label_refused');
 expect(()=>parseLabelResponse(body({regions:[{photo_index:0,x:2,y:0,w:1,h:1,rotation:0}]}),'label_locator',1)).toThrow('label_invalid_regions');
 expect(parseLabelResponse(body({regions:[]}), 'label_locator',1).regions).toEqual([]);
});
it('records a parseable but invalid label reply as invalid_response',async()=>{
 const {parseLabelResponse}=await import('../src/services/labelResponse');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({content:[{type:'text',text:'{"reads":null}'}]}))));
 await recognitionAudit.run({runId:'run',deadline:Date.now()+2000},()=>auditedFetch('https://provider.test',{method:'POST',body:JSON.stringify({model:'fixture',messages:[]})},'label_reader',b=>parseLabelResponse(b,'label_reader',1)));
 const values=vi.mocked(pool.query).mock.calls.find(c=>String(c[0]).includes('raw_output'))![1] as any[];
 expect(values[1]).toBe('invalid_response');
});
it('rejects a sharp frame edge as model-line detail',async()=>{
 const {hasModelLineDetail}=await import('../src/services/labelReading');
 const pixels=Buffer.from(Array.from({length:80*20},(_,i)=>i%80<40?0:255));
 expect(await hasModelLineDetail(await sharp(pixels,{raw:{width:80,height:20,channels:1}}).png().toBuffer())).toBe(false);
});
it('removes unmatched geometry dimensions and unsupported geometry prose with a reason',async()=>{
 const {comparisonPayload,sanitizeReferenceComparison}=await import('../src/services/referenceEvidence');
 const stage={installation_geometry:{status:'insufficient_visible_landmarks',candidates:[],reference_dimensions:[{model:'fixture',width:12}]}};
 expect((comparisonPayload({stage_one:stage,pages:[],conflicts:[]}).stage_one.installation_geometry as any).reference_dimensions).toBeUndefined();
 const result=sanitizeReferenceComparison({candidates:[{supporting_features:[{observation:'catalog geometry matches'}]}],unresolved:['Identification relies on catalog geometry only','No dimensional match.']},stage);
 expect(result.candidates[0].supporting_features).toEqual([]);expect(result.unresolved).toEqual(['Identification relies on catalog geometry only','No dimensional match.']);expect(result.reasoning_adjustments).toHaveLength(1);
});

it.each(['manufacturer','Visible_Text','arm_type'])('quarantines unsupported brand evidence regardless of tag %s',async supports=>{
 const {applyLabelEvidence}=await import('../src/services/labelReading');const {sanitizeReferenceComparison}=await import('../src/services/referenceEvidence');
 const stage=applyLabelEvidence({manufacturer:'RYOBI',evidence:[{supports,observation:'Label reads RYOBI, not LCN.'}]},{version:'test',status:'completed',reads:[],limiting_factor:null});
 expect(stage.evidence).toEqual([]);expect(stage.classifier_text_evidence).toHaveLength(1);
 const clean=sanitizeReferenceComparison({candidates:[{contradicting_features:[{observation:'Label reads RYOBI, not LCN.'}]}]},stage);
 expect(clean.candidates[0].contradicting_features).toEqual([]);
});
it('normalizes comparison shapes, excludes off-reference candidates and provider decision fields',async()=>{
 const {comparisonShape}=await import('../src/services/comparisonShape');
 const pages=[{brand:'LCN',models:['4040XP']}];
 const clean=comparisonShape({candidates:[{manufacturer:'RYOBI',model:'P1'},{manufacturer:'LCN',model:'4040XP',identity_verified:true,contradicting_features:['RYOBI',{},null,{observation:'Valve differs'}]}],unresolved:{text:'bad'},cover_comparison:'unavailable_without_installed_cover',identity_verified:true},pages);
 expect(clean.candidates).toHaveLength(1);expect(clean.candidates[0].contradicting_features).toEqual([{observation:'Valve differs',citation:null}]);
 expect(clean.unresolved).toEqual([]);expect(clean).not.toHaveProperty('cover_comparison');expect(clean).not.toHaveProperty('identity_verified');expect(clean.reasoning_adjustments.length).toBeGreaterThan(4);
 expect(comparisonShape({candidates:'bad',unresolved:['ok',{}]}).unresolved).toEqual(['ok']);
});
it('shares fenced JSON parsing and rejects refusal/prose objects, while class aliases are explicit',async()=>{
 const {providerObject,classifierObject}=await import('../src/services/providerReply');
 expect(providerObject({content:[{type:'text',text:'```JSON\n{"candidates":[]}\n```'}]})).toEqual({candidates:[]});
 expect(()=>providerObject({stop_reason:'refusal',content:[{type:'text',text:'{"component_class":null}'}]})).toThrow();
 expect(()=>providerObject({content:[{type:'text',text:'I refuse {"component_class":null}'}]})).toThrow();
 expect(()=>classifierObject({})).toThrow();expect(()=>classifierObject({component_class:'random'})).toThrow();
 expect(classifierObject({component_class:'door closer'}).component_class).toBe('DOOR_CLOSER');expect(classifierObject({component_class:null}).component_class).toBeNull();
});

it('preserves physical contradictions and geometry cautions when quarantining label text',async()=>{
 const {sanitizeReferenceComparison}=await import('../src/services/referenceEvidence');
 const observations=['Label reads RYOBI, not LCN.','The closer body differs','Arm shape differs','Mounting pattern differs'];
 const result=sanitizeReferenceComparison({candidates:[{supporting_features:[{observation:'Geometry matches'}],contradicting_features:observations.map(observation=>({observation}))}],unresolved:['Catalog geometry alone cannot establish identity']},{photograph_identity:{manufacturer:'RYOBI'},classifier_text_evidence:[{observation:"Text 'RYOBI' visible on the closer body"}],installation_geometry:{candidates:[]}});
 expect(result.candidates[0].contradicting_features.map((f:any)=>f.observation)).toEqual(observations.slice(1));
 expect(result.candidates[0].supporting_features).toEqual([]);
 expect(result.unresolved).toEqual(['Catalog geometry alone cannot establish identity']);
});
