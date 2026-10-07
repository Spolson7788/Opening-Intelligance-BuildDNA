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
 const pair=labels(read('PDQ',0,'brand_mark'),read('Model 6999R',1,'product_label'));
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

it('distinguishes invalid device association from an actual other-device finding',()=>{
 const logo=read('PDQ',0,'brand_mark');logo.provenance={source:'focused_crop',target_device:false,association_status:'invalid',location_validated:true};
 const result=catalogIdentityReview(labels(logo,read('6200R',1,'product_label')));
 expect(result.candidates).toEqual([]);expect(result.excluded_evidence[0].reason).toBe('invalid_device_association');
});

it('fuses a verified complete supplied maker view with a separately read model, and rejects incomplete views',()=>{
 const maker=read('PDQ',0,'brand_mark');maker.provenance={source:'focused_view',target_device:true,location_validated:true,verification_scope:'supplied_view',marking_complete:true,view_index:1,box:{x:.2,y:.2,w:.4,h:.4},rotation:90};
 const model=read('Model 6200R',1,'product_label');model.provenance={source:'native_tile',target_device:true,location_validated:true};
 const review=catalogIdentityReview(labels(maker,model));
 expect(applyCatalogIdentityProposal({},review)).toMatchObject({manufacturer:'PDQ',series:'6200',model:'6200R'});
 expect(review.candidates[0].evidence.map((e:any)=>e.photo_index)).toEqual([1,0]);
 for(const bad of [{marking_complete:false},{view_index:4},{verification_scope:undefined},{target_device:false},{location_validated:false}])expect(catalogIdentityReview(labels({...maker,provenance:{...maker.provenance,...bad}},model)).candidates).toEqual([]);
 expect(catalogIdentityReview(labels({...maker,vision_text:'DORMA'},model)).status).toBe('CONFLICT');
});

const grouped=(...reads:LabelRead[]):LabelEvidence=>({...labels(...reads.map(r=>({...r,provenance:{source:'grouped_view',target_device:true,location_validated:true,verification_scope:'supplied_view',marking_complete:true}} as LabelRead))),version:'oi-grouped-device-1'});
it('preserves literal maker and same-photo series without inventing an exact configuration',()=>{
 const review=catalogIdentityReview(grouped(read('VON DUPRIN INDPLS, IN',2,'brand_mark'),read('35A SERIES',2,'product_label'),read('ED35A. 11824',0,'product_label')),{component_class:'EXIT_DEVICE',grouped_identity_claim:{disagreements:['Labels may belong to separate leaves.']}});
 expect(review.status).toBe('PARTIAL_IDENTITY');expect(review.reader_disagreements).toEqual(['Labels may belong to separate leaves.']);
 expect(applyCatalogIdentityProposal({},review)).toMatchObject({manufacturer:'Von Duprin',series:'35A',model:null,identity_level:'series',confidence:{model:null}});
 expect(review.partial_identity.evidence.map((e:any)=>e.photo_index)).toEqual([2,2]);
});
it('does not infer series from reader claims, part codes, uncertain markings or another leaf',()=>{
 for(const [text,photo] of [['ED35A. 11824',2],['3?A SERIES',2],['35A SERIES',1]] as const){
  const review=catalogIdentityReview(grouped(read('VON DUPRIN',2,'brand_mark'),read(text,photo,'product_label')),{grouped_identity_claim:{series:'35A'}});
  expect(review.partial_identity).toMatchObject({manufacturer:'Von Duprin',series:null,model:null});
 }
});
it('retains type and maker conflicts instead of silently accepting a family',()=>{
 const evidence=grouped(read('VON DUPRIN',2,'brand_mark'),read('35A SERIES',2,'product_label'));
 const review=catalogIdentityReview(evidence,{component_class:'DOOR_CLOSER'});expect(review.status).toBe('TYPE_CONFLICT');
 expect(applyCatalogIdentityProposal({},review).identity_status).toBe('type_conflict');
 expect(catalogIdentityReview(grouped(...evidence.reads,read('DORMA',0,'brand_mark'))).status).toBe('CONFLICT');
});
it('keeps a catalog model that doubles as a series from turning a family label into a configuration',()=>{
 const family=catalogIdentityReview(grouped(read('VON DUPRIN',0,'brand_mark'),read('35A SERIES',0,'product_label')));
 expect(family.candidates).toEqual([]);expect(family.partial_identity.model).toBeNull();
 const exact=catalogIdentityReview(grouped(read('VON DUPRIN',0,'brand_mark'),read('MODEL 35A',1,'product_label')));
 expect(exact.candidates).toHaveLength(1);expect(exact.candidates[0]).toMatchObject({model:'35A',device_type:'rim',series:'35A'});
});
it('retains the literal Yale brand through the documented commercial rebrand and rejects shared-model wrong-maker pairs',()=>{
 const review=catalogIdentityReview(grouped(read('YALE',0,'brand_mark'),read('Model 7100',1,'product_label')));
 expect(review.candidates).toHaveLength(1);expect(review.candidates[0]).toMatchObject({manufacturer:'Yale',series:'7000',model:'7100',device_type:'rim'});
 expect(catalogIdentityReview(grouped(read('DORMA',0,'brand_mark'),read('Model 7100',1,'product_label'))).status).toBe('CONFLICT');
});
it('retains a complete embedded Yale series marking with maker evidence on the same label',()=>{
 const evidence=grouped(read('Yale®',1,'brand_mark'),read('c UL us LISTED Yale® FIRE EXIT HARDWARE ISSUE No. U-311 7000 SERIES',3,'product_label'));
 const review=catalogIdentityReview(evidence,{grouped_identity_claim:{series:'7000 Series',disagreements:['Check rod configuration.']}});
 expect(applyCatalogIdentityProposal({},review)).toMatchObject({manufacturer:'Yale',series:'7000',model:null,series_basis:'literal_series_marking'});
 expect(review.partial_identity.evidence.some((e:any)=>e.kind==='series'&&e.photo_index===3)).toBe(true);
 expect(review.reader_disagreements).toEqual(['Check rod configuration.']);
});
it('does not extract a family from compatibility labels or a neighboring uncertain token',()=>{
 for(const value of ['Yale trim fits 7000 SERIES','Yale compatible with SERIES 7000','Yale 17000 SERIES','Yale 700? SERIES','Yale 7000? SERIES']){
  const review=catalogIdentityReview(grouped(read('Yale',1,'brand_mark'),read(value,1,'product_label')));
  expect(review.partial_identity?.series).toBeNull();
 }
 const missing=grouped(read('Yale',1,'brand_mark'),read('Yale 7000 SERIES',1,'product_label'));delete missing.reads[1].provenance;
 expect(catalogIdentityReview(missing).partial_identity?.series).toBeNull();
});
it('does not convert an embedded series-only label or compatibility reference into an exact model',()=>{
 const maker=read('VON DUPRIN',0,'brand_mark');
 const series=catalogIdentityReview(grouped(maker,read('UL LISTED VON DUPRIN 35A SERIES',0,'product_label')));
 expect(series.candidates).toEqual([]);expect(series.partial_identity).toMatchObject({series:'35A',model:null});
 const model=catalogIdentityReview(grouped(maker,read('MODEL: 35A; 35A SERIES',0,'product_label')));
 expect(model.candidates).toHaveLength(1);expect(model.candidates[0].model).toBe('35A');
 expect(catalogIdentityReview(grouped(read('PDQ',0,'brand_mark'),read('HG1 trim compatible with PDQ 6200R',0,'product_label'))).candidates).toEqual([]);
});
