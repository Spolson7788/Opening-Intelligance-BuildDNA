import {describe,it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {agreedMarkings,enhanceLabelCrop,searchRegions,normalizeRegions,cropLabel,applyLabelEvidence,labelCandidates,readLabels, type LabelEvidence} from '../src/services/labelReading';
const region={photo_index:0,x:.1,y:.2,w:.5,h:.2,rotation:180};
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

it('keeps a single-reader label candidate separate and suppresses conflicting model digits',()=>{
 const labels=evidence('', 'LCN 4040XP');
 expect(labelCandidates(labels.reads)).toEqual([{manufacturer:'LCN',series:'4040',model:'4040XP',verification:'single_reader'}]);
 expect(labelCandidates(evidence('4041','LCN 4040XP').reads)).toEqual([]);
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
 expect(labelCandidates(evidence('4041','4040XP').reads)).toEqual([]);
});

it('preserves the live partial 4040X? reading for references without inventing the missing P',()=>{
 const labels=evidence('Fae', '4040X?');
 const candidate=labelCandidates(labels.reads)[0];
 expect(candidate).toEqual({manufacturer:'LCN',series:'4040',model:null,verification:'single_reader',manufacturer_basis:'catalog_partial_model_match',transcribed_marking:'4040X?'});
 expect(labelCandidates(evidence('4041', '4040X?').reads)).toEqual([]);
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
