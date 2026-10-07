import {it,expect} from 'vitest';
import {catalogIdentityReview,applyCatalogIdentityProposal} from '../src/services/catalogIdentityReview';
import type {LabelEvidence,LabelRead} from '../src/services/labelReading';
const read=(text:string,photo:number,kind:'brand_mark'|'product_label'):LabelRead=>({region:{photo_index:photo,x:0,y:0,w:1,h:1,rotation:0,kind},vision_text:text,vision_status:'read',ocr_text:'',ocr_confidence:0,agreed_markings:[],status:'unconfirmed'});
const labels=(...reads:LabelRead[]):LabelEvidence=>({version:'test',status:'completed',reads,limiting_factor:null});
it('links separate photos of a cast maker mark and exact model without treating classifier as truth',()=>{
 const result=catalogIdentityReview(labels(read('PDQ',0,'brand_mark'),read('Model 6200R',1,'product_label')),{manufacturer:'DORMA',model:'6200R'});
 expect(result.status).toBe('CANDIDATES');expect(result.candidates).toHaveLength(1);
 expect(result.candidates[0]).toMatchObject({manufacturer:'PDQ',series:'6200',model:'6200R',verification:'pending_technician',discontinued_confirmed:false});
 expect(result.candidates[0].evidence.map(e=>e.photo_index)).toEqual([1,0]);expect(result.classifier_claim.manufacturer).toBe('DORMA');
});

it('exposes the exact photo-supported pair as a proposal without inventing confidence or technician confirmation',()=>{
 const review=catalogIdentityReview(labels(read('PDQ',0,'brand_mark'),read('Model 6200R',1,'product_label')),{manufacturer:'DORMA'});
 const suggestion=applyCatalogIdentityProposal({component_class:'EXIT_DEVICE',manufacturer:null,series:null,model:null},review);
 expect(suggestion).toMatchObject({manufacturer:'PDQ',series:'6200',model:'6200R',identity_status:'pending_technician',confidence:{manufacturer:null,series:null,model:null}});
 expect(suggestion.identity_evidence.map((e:any)=>e.photo_index)).toEqual([1,0]);
 expect(suggestion.catalog_identity_review.classifier_claim.manufacturer).toBe('DORMA');
 const conflict=catalogIdentityReview(labels(read('DORMA',0,'brand_mark'),read('6200R',1,'product_label')));
 expect(applyCatalogIdentityProposal({manufacturer:null},conflict)).toEqual({manufacturer:null});
 const typeReview=catalogIdentityReview(labels(read('PDQ',0,'brand_mark'),read('6200R',1,'product_label')),{component_class:'DOOR_CLOSER'},{component_type:'exit_device',component_type_source:'technician'});
 expect(typeReview.status).toBe('TYPE_CONFLICT');
 expect(applyCatalogIdentityProposal({component_class:'DOOR_CLOSER'},typeReview)).toMatchObject({manufacturer:'PDQ',series:'6200',model:'6200R',component_class:'EXIT_DEVICE',identity_status:'type_conflict'});
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

it('distinguishes readable unsupported pairs from a catalog outage',()=>{
 const pair=labels(read('PDQ',0,'brand_mark'),read('Model 6300R',1,'product_label'));
 expect(catalogIdentityReview(pair).status).toBe('UNSUPPORTED_BY_CATALOG');
 expect(catalogIdentityReview(pair,{}, {},null).status).toBe('CATALOG_UNAVAILABLE');
});
it('does not reject an exact model because an unrelated label token is uncertain',()=>{
 expect(catalogIdentityReview(labels(read('PDQ',0,'brand_mark'),read('MODEL6200R UL LIST?D',1,'product_label'))).candidates[0].model).toBe('6200R');
});
it('excludes context or other-device readings without manufacturing a conflict',()=>{
 const foreign=read('DORMA',2,'brand_mark');foreign.provenance={source:'native_tile',target_device:false,location_validated:true};
 const result=catalogIdentityReview(labels(read('PDQ',0,'brand_mark'),read('6200R',1,'product_label'),foreign));
 expect(result.status).toBe('CANDIDATES');expect(result.excluded_evidence).toHaveLength(1);
 foreign.provenance={source:'context',target_device:true,location_validated:false};
 expect(catalogIdentityReview(labels(foreign,read('6200R',1,'product_label'))).status).toBe('INSUFFICIENT_EVIDENCE');
});
it('uses catalog data for other brands and does not treat a default as technician evidence',()=>{
 const catalog=[{manufacturer:'Example',series:'99',model:'99EO',component_class:'EXIT_DEVICE',display_name:'rim exit device'}];
 const result=catalogIdentityReview(labels(read('Example',0,'brand_mark'),read('Model 99EO',1,'product_label')),{component_class:'EXIT_DEVICE'},{component_type:'lockset',component_type_source:'default'},catalog);
 expect(result.status).toBe('CANDIDATES');expect(result.candidates[0].series).toBe('99');
});

it('retains validated maker disagreement across broad and focused reads as a conflict',()=>{
 const a=read('DORMA',0,'brand_mark'),b=read('PDQ',0,'brand_mark'),m=read('6200R',1,'product_label');
 a.provenance={source:'native_tile',target_device:true,location_validated:true};b.provenance={source:'focused_crop',target_device:true,location_validated:true};m.provenance={source:'native_tile',target_device:true,location_validated:true};
 expect(catalogIdentityReview(labels(a,b,m)).status).toBe('CONFLICT');
 a.provenance.location_validated=false;expect(catalogIdentityReview(labels(a,b,m)).status).toBe('CANDIDATES');expect(catalogIdentityReview(labels(a,b,m)).excluded_evidence[0].text).toBe('DORMA');
});
