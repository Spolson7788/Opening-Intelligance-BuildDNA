import {it,expect} from 'vitest';
import {catalogIdentityReview} from '../src/services/catalogIdentityReview';
import type {LabelEvidence,LabelRead} from '../src/services/labelReading';
const read=(text:string,photo:number,kind:'brand_mark'|'product_label'):LabelRead=>({region:{photo_index:photo,x:0,y:0,w:1,h:1,rotation:0,kind},vision_text:text,vision_status:'read',ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed'});
const labels=(...reads:LabelRead[]):LabelEvidence=>({version:'test',status:'completed',reads,limiting_factor:null});
it('links separate photos of a cast maker mark and exact model without treating classifier as truth',()=>{
 const result=catalogIdentityReview(labels(read('PDQ',0,'brand_mark'),read('Model 6200R',1,'product_label')),{manufacturer:'DORMA',model:'6200R'});
 expect(result.status).toBe('CANDIDATES');expect(result.candidates).toHaveLength(1);
 expect(result.candidates[0]).toMatchObject({manufacturer:'PDQ',series:'6200',model:'6200R',verification:'pending_technician',discontinued_confirmed:false});
 expect(result.candidates[0].evidence.map(e=>e.photo_index)).toEqual([1,0]);expect(result.classifier_claim.manufacturer).toBe('DORMA');
});
it('does not infer maker from model, trim compatibility or a partial logo',()=>{
 for(const reads of [[read('6200R',1,'product_label')],[read('PD?',0,'brand_mark'),read('6200R',1,'product_label')],[read('PDQ',0,'brand_mark'),read('HG1 fits Hager 4500 / PDQ 6200',1,'product_label')]]){
  expect(catalogIdentityReview(labels(...reads)).status).toBe('INSUFFICIENT_EVIDENCE');
 }
});
it('preserves a conflicting readable maker rather than silently choosing the catalog maker',()=>{
 const result=catalogIdentityReview(labels(read('DORMA',0,'brand_mark'),read('6200R',1,'product_label')));
 expect(result.status).toBe('CONFLICT');expect(result.candidates).toEqual([]);expect(result.maker_evidence[0].text).toBe('DORMA');
});
it('matches exact suffixes, and rejects uncertain or conflicting model transcriptions',()=>{
 const brand=read('PDQ',0,'brand_mark');
 expect(catalogIdentityReview(labels(brand,read('6200RF',1,'product_label'))).candidates.map(c=>c.model)).toEqual(['6200RF']);
 expect(catalogIdentityReview(labels(brand,read('6200R?',1,'product_label'))).candidates).toEqual([]);
 const bad=read('6200R',1,'product_label');bad.ocr_model_conflicts=['6300R'];
 expect(catalogIdentityReview(labels(brand,bad)).candidates).toEqual([]);
});
