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
 const values=vi.mocked(pool.query).mock.calls[1][1] as any[];
 expect(values[1]).toBe('response_received');expect(values[4]).toBeCloseTo(.0006);expect(values[5]).toBe('estimated');expect(values[6]).toBe(raw);
});
it('aborts the underlying provider call and persists timeout with unknown usage and cost',async()=>{
 let aborted=false;
 vi.stubGlobal('fetch',vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason);},{once:true}))));
 await expect(invoke(Date.now()+30)).rejects.toThrow();expect(aborted).toBe(true);
 expect(vi.mocked(pool.query).mock.calls[1][1]?.[1]).toBe('timeout');
});
it('records transport and provider failures without inventing token counts',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValueOnce(new Response('{"error":"unavailable"}',{status:503})));
 await expect(invoke()).rejects.toThrow('network');expect(vi.mocked(pool.query).mock.calls[1][1]?.[1]).toBe('error');
 await invoke();expect(vi.mocked(pool.query).mock.calls[3][1]?.[1]).toBe('provider_error');expect(vi.mocked(pool.query).mock.calls[3][1]?.[4]).toBeNull();
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
it('does not promote shadow-run hypotheses into operational photo provenance',()=>{
 expect(identityValues({manufacturer:'Norton',model_number:'7500',identity_source:'photo_suggestion',identity_acknowledged:true},'actor',{stage_one:{shadow_mode:true},suggestion:{manufacturer:'Norton',model:'7500'}})).toMatchObject({identity_source:'technician_identified',identity_value_producer:'technician'});
});
