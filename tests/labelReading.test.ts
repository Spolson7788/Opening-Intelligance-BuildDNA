import {describe,it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {createWorker} from 'tesseract.js';
vi.mock('tesseract.js',async importOriginal=>{const actual=await importOriginal<typeof import('tesseract.js')>();return {...actual,createWorker:vi.fn(actual.createWorker)};});
import {agreedMarkings,enhanceLabelCrop,searchRegions,normalizeRegions,cropLabel,applyLabelEvidence,labelCandidates,readLabels, type LabelEvidence} from '../src/services/labelReading';
import {modelLineViews,conflictingModelReadings} from '../src/services/labelReading';
const region={photo_index:0,x:.1,y:.2,w:.5,h:.2,rotation:180};
it.each([90,180,270])('crops the original model-line pixels before rotation by %s degrees',async rotation=>{
 const raw=Buffer.alloc(120*80*3);
 for(let y=0;y<80;y++)for(let x=0;x<120;x++){const i=(y*120+x)*3;raw[i]=x*2;raw[i+1]=y*3;raw[i+2]=(x+y)%256;}
 const source=await sharp(raw,{raw:{width:120,height:80,channels:3}}).png().toBuffer();
 const box={x:.1,y:.6,w:.3,h:.2};
 const expectedCrop=await sharp(source).extract({left:12,top:48,width:36,height:16}).png().toBuffer();
 const expected=await sharp(expectedCrop).rotate(rotation).resize({height:96,width:1200,fit:'inside'}).extend({top:10,bottom:10,left:10,right:10,background:'white'}).png().toBuffer();
 const actual=(await modelLineViews(source,{...region,rotation,model_line_box:box}))[0];
 expect(await sharp(actual).raw().toBuffer()).toEqual(await sharp(expected).raw().toBuffer());
});
it('retains the visual candidate and exposes a stray conflicting OCR model',()=>{
 expect(labelCandidates(evidence('4040XP 2040xp','LCN 4040XP').reads)[0].model).toBe('4040XP');
 expect(conflictingModelReadings('4040XP 2040xp','LCN 4040XP')).toEqual(['2040XP']);
 expect(conflictingModelReadings('4040','4040XP')).toEqual([]);
});
function evidence(ocr:string,vision:string):LabelEvidence{return {version:'fixture',status:'completed',limiting_factor:null,reads:[{region,ocr_text:ocr,ocr_confidence:70,vision_text:vision,agreed_markings:agreedMarkings(ocr,vision),status:'agreement'}]};}
describe('label reading evidence',()=>{
 it('keeps exact agreed characters without completing model suffixes',()=>{
  expect(agreedMarkings('LCN 4040','LCN 4040')).toEqual(['LCN','4040']);
  expect(agreedMarkings('LCN 4040','LCN 4040XP')).toEqual(['LCN']);
  expect(agreedMarkings('4O4O','4040')).toEqual([]);
 });
 it('preserves family identity and leaves the exact model unknown',()=>{
  const r=applyLabelEvidence({manufacturer:null,model:null,series:null,visible_text:[]},evidence('LCN 4040','LCN 4040'));
  expect(r).toMatchObject({manufacturer:'LCN',series:'4040',model:null,visible_text:['LCN','4040']});
 });
 it('does not turn an uncorroborated reading into product identity',()=>{
  const r=applyLabelEvidence({manufacturer:null,model:null,visible_text:[]},evidence('other','LCN 4040XP'));
  expect(r.manufacturer).toBeNull();expect(r.model).toBeNull();
 });
 it('rejects invalid source coordinates and bounds every crop to its own photograph',()=>{
  expect(normalizeRegions([{...region,photo_index:9},{...region,x:-1},{...region,w:0},{...region,x:NaN}],1)).toEqual([]);
  expect(normalizeRegions([{...region,x:.9,w:2}],1)[0].w).toBeCloseTo(.1);
 });
 it('crops and rotates real pixels without changing the original photograph',async()=>{
  const source=await sharp({create:{width:200,height:100,channels:3,background:'white'}}).png().toBuffer();
  const copy=Buffer.from(source);
  const crop=await cropLabel(source,{photo_index:0,x:.1,y:.1,w:.5,h:.2,rotation:90});
  const m=await sharp(crop).metadata();
  expect(m.height!).toBeGreaterThan(m.width!);expect(source.equals(copy)).toBe(true);
 });
 it('fails open for physical recognition when label provider is unavailable',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Error('private provider detail')));
  try{const result=await readLabels([Buffer.from('invalid')],'image/jpeg');expect(result.status).toBe('unavailable');expect(JSON.stringify(result)).not.toContain('private');}finally{vi.unstubAllGlobals();}
 });
});

it('keeps a single-reader label candidate available despite conflicting model digits',()=>{
 const labels=evidence('', 'LCN 4040XP');
 expect(labelCandidates(labels.reads)).toEqual([{manufacturer:'LCN',series:'4040',model:'4040XP',verification:'single_reader'}]);
 expect(labelCandidates(evidence('4041','LCN 4040XP').reads)[0].model).toBe('4040XP');
 expect(labelCandidates(evidence('4040','LCN 4040XP').reads)[0].model).toBeNull();
});

it('search tiles retain the body label even when the locator chooses the wrong area',()=>{
 const label={x:.23,y:.69,w:.2,h:.19};
 const covers=searchRegions().filter(r=>r.x<=label.x&&r.y<=label.y&&r.x+r.w>=label.x+label.w&&r.y+r.h>=label.y+label.h);
 expect(covers.some(r=>r.rotation===0)).toBe(true);
 expect(covers.some(r=>r.rotation===180)).toBe(true);
 expect(searchRegions().every(r=>r.kind==='search_tile')).toBe(true);
});

it('uses an exact model-only reading as a catalog candidate, without asserting a photographed manufacturer',()=>{
 const reads=evidence('', '4040XP').reads;
 expect(labelCandidates(reads)).toEqual([{manufacturer:'LCN',series:'4040',model:'4040XP',verification:'single_reader',manufacturer_basis:'catalog_model_match'}]);
 expect(labelCandidates(evidence('', '4040').reads)).toEqual([]);
 const result=applyLabelEvidence({manufacturer:null,model:null,series:null}, {...evidence('', '4040XP'), candidates:labelCandidates(reads)});
 expect(result.manufacturer).toBeNull();
 expect(result.model).toBeNull();
 expect(labelCandidates(evidence('4041','4040XP').reads)[0].model).toBe('4040XP');
});

it('preserves the live partial 4040X? reading for references without inventing the missing P',()=>{
 const labels=evidence('Fae', '4040X?');
 const candidate=labelCandidates(labels.reads)[0];
 expect(candidate).toEqual({manufacturer:'LCN',series:'4040',model:null,verification:'single_reader',manufacturer_basis:'catalog_partial_model_match',transcribed_marking:'4040X?'});
 expect(labelCandidates(evidence('4041', '4040X?').reads)[0].transcribed_marking).toBe('4040X?');
 expect(labelCandidates(evidence('', '4040X1').reads)).toEqual([]);
 expect(applyLabelEvidence({manufacturer:null,model:null},labels).model).toBeNull();
});

it('does not let a compatible partial crop disable an exact reading from another crop',()=>{
 const readings=[...evidence('', '4040XP').reads,...evidence('', '4040X?').reads];
 expect(labelCandidates(readings)).toEqual([{manufacturer:'LCN',series:'4040',model:'4040XP',verification:'single_reader',manufacturer_basis:'catalog_model_match'}]);
});

it('enhances low contrast without changing dimensions or overwriting original pixels',async()=>{
 const pixels=Buffer.from(Array.from({length:40*20*3},(_,i)=>Math.floor(i/3)%40<20?30:60));
 const source=await sharp(pixels,{raw:{width:40,height:20,channels:3}}).png().toBuffer();
 const unchanged=Buffer.from(source);
 const enhanced=await enhanceLabelCrop(source);
 const metadata=await sharp(enhanced).metadata();
 expect(metadata.width).toBe(40);expect(metadata.height).toBe(20);expect(source.equals(unchanged)).toBe(true);
 const output=await sharp(enhanced).raw().toBuffer();
 expect(Math.max(...output)-Math.min(...output)).toBeGreaterThan(30);
});

it('isolates a reader-located label and supplies both orientations without modifying its source',async()=>{
 const {focusedLabelViews}=await import('../src/services/labelReading');
 const input=await sharp({create:{width:240,height:160,channels:3,background:'white'}}).png().toBuffer();const copy=Buffer.from(input);
 const views=await focusedLabelViews(input,{x:.1,y:.2,w:.3,h:.2},90);
 expect(views).toHaveLength(2);expect(input.equals(copy)).toBe(true);
 const rotated=await sharp(views[0]).rotate(180).png().toBuffer();expect(views[1].equals(rotated)).toBe(true);
 expect(await focusedLabelViews(input,{x:-1,y:0,w:.3,h:.2},0)).toEqual([]);
});

it('enlarges the whole small image before label location, preserving aspect ratio and source bytes',async()=>{
 const {enlargeForLabelLocation}=await import('../src/services/labelReading');
 const input=await sharp({create:{width:438,height:238,channels:3,background:'grey'}}).png().toBuffer();const copy=Buffer.from(input);
 const enlarged=await enlargeForLabelLocation(input);expect(enlarged).not.toBeNull();
 const m=await sharp(enlarged!).metadata();expect(m.width).toBe(1314);expect(m.height).toBe(714);expect(input.equals(copy)).toBe(true);
 const large=await sharp({create:{width:1700,height:1000,channels:3,background:'grey'}}).png().toBuffer();
 expect(await enlargeForLabelLocation(large)).toBeNull();
});
it('supplies the enlarged full-frame image to the first locator call with original coordinate mapping',async()=>{
 const input=await sharp({create:{width:100,height:60,channels:3,background:'grey'}}).png().toBuffer();
 const deadline=Date.now()+10000;const clock=vi.spyOn(Date,'now');
 const fetch=vi.fn().mockImplementation(async()=>{clock.mockReturnValue(deadline+1);throw Error('provider unavailable');});vi.stubGlobal('fetch',fetch);
 try{
  await readLabels([input],'image/png',deadline);
  const body=JSON.parse(fetch.mock.calls[0][1].body);const content=body.messages[0].content;const images=content.filter((c:any)=>c.type==='image');
  expect(images).toHaveLength(2);expect(images[0].source.data).toBe(input.toString('base64'));
  expect((await sharp(Buffer.from(images[1].source.data,'base64')).metadata()).width).toBe(300);
  expect(content.some((c:any)=>c.type==='text'&&c.text.includes('Same pixels and normalized coordinates'))).toBe(true);
 }finally{clock.mockRestore();vi.unstubAllGlobals();}
});


it('validates a model-line location inside the observed label and rejects invented/outside boxes',()=>{
 const line={x:.2,y:.22,w:.25,h:.04};
 expect(normalizeRegions([{...region,model_line_box:line}],1)[0].model_line_box).toEqual(line);
 expect(normalizeRegions([{...region,model_line_box:{...line,x:.9}}],1)[0].model_line_box).toBeUndefined();
 expect(normalizeRegions([{...region,model_line_box:{...line,x:NaN}}],1)[0].model_line_box).toBeUndefined();
});
it('gives OCR original and enhanced focused model-line pixels in both orientations without inserting reference text',async()=>{
 const {modelLineViews,LABEL_LAYOUT_REFERENCE}=await import('../src/services/labelReading');
 const input=await sharp({create:{width:500,height:375,channels:3,background:'white'}}).png().toBuffer();const copy=Buffer.from(input);
 const views=await modelLineViews(input,{photo_index:0,x:.63,y:.38,w:.26,h:.18,rotation:0,model_line_box:{x:.65,y:.39,w:.12,h:.04}});
 expect(views).toHaveLength(4);expect(input.equals(copy)).toBe(true);
 expect((await sharp(views[0]).metadata()).width!).toBeGreaterThan((await sharp(views[0]).metadata()).height!);
 expect(LABEL_LAYOUT_REFERENCE.guide).not.toMatch(/4040|LCN|XP/);
 expect(await modelLineViews(input,region)).toEqual([]);
});

it('retains completed OCR reads when a later crop times out and identifies unattempted crops',async()=>{
 const {readLabelCropsOcr}=await import('../src/services/labelReading');
 const setParameters=vi.fn().mockResolvedValue(undefined);const terminate=vi.fn().mockResolvedValue(undefined);
 const recognize=vi.fn().mockResolvedValueOnce({data:{text:'4040XP',confidence:82}}).mockImplementationOnce(()=>new Promise(()=>{}));
 vi.mocked(createWorker).mockResolvedValueOnce({setParameters,recognize,terminate} as any);
 const result=await readLabelCropsOcr([Buffer.alloc(0),Buffer.alloc(0),Buffer.alloc(0)],Date.now()+100,['model_line','model_line','label']);
 expect(result[0]).toMatchObject({text:'4040XP',status:'read'});
 expect(result[1].status).toBe('timeout');expect(result[2].status).toBe('not_attempted');
 expect(setParameters.mock.calls[0][0].tessedit_pageseg_mode).toBe('7');
});
it('distinguishes a failed OCR worker from an unreadable completed crop',async()=>{
 const {readLabelCropsOcr}=await import('../src/services/labelReading');
 vi.mocked(createWorker).mockRejectedValueOnce(Error('private detail'));
 const result=await readLabelCropsOcr([Buffer.alloc(0)],Date.now()+1000);
 expect(result[0].status).toBe('unavailable');expect(JSON.stringify(result)).not.toContain('private detail');
});
