import {describe,it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {agreedMarkings,normalizeRegions,cropLabel,applyLabelEvidence,labelCandidates,readLabels, type LabelEvidence} from '../src/services/labelReading';
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
