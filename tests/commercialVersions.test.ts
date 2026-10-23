import {expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app';
import {createFixtureCommercialStore,CommercialStore} from '../src/services/commercialStorage';
import {estimateTotals} from '../src/services/estimateMath';
import {signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {pool} from '../src/db/pool';
async function fixture(){
 const store=createFixtureCommercialStore(),api=createApp({commercialStore:store}),owner=await signupTestOrg(),provider=await signupTestOrg(),other=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token),o=await createTestOpening(owner.token,scope.buildingId,{opening_configuration:'single'});
 const auth=(token:string)=>({Authorization:'Bearer '+token}),post=(path:string,b:any,token=provider.token)=>request(api).post('/api/commercial'+path).set(auth(token)).send(b);
 await request(api).put(`/api/provider-assignments/${scope.propertyId}/${provider.organizationId}`).set(auth(owner.token)).send({active:true});
 await request(api).put('/api/openings/'+o.id+'/frame').set(auth(owner.token)).send({condition:'good'});
 const leaf=(await request(api).post('/api/openings/'+o.id+'/door-leaves').set(auth(owner.token)).send({leaf_role:'single',condition:'good'})).body;
 const h=(await request(api).post('/api/hardware').set(auth(owner.token)).send({opening_id:o.id,component_type:'closer',mounting_scope:'door_leaf',door_leaf_id:leaf.id,condition:'failed',review_state:'reviewed',replacement_required:true,identity_status:'established',manufacturer:'Synthetic',model_number:'Old'})).body;
 expect((await request(api).post('/api/openings/'+o.id+'/complete').set(auth(owner.token))).status).toBe(200);
 await request(api).put('/api/purchasing/approvals/'+h.id).set(auth(owner.token)).send({document_url:'https://synthetic.invalid/technical-proof',document_sha256:'a'.repeat(64),provenance:'technician_selected',active:true});
 const doc={id:randomUUID(),version_id:randomUUID(),expected_version:0,property_id:null,title:'Synthetic cut sheet',kind:'cut_sheet',pdf_base64:Buffer.from('%PDF-1.4\nSynthetic test evidence\n%%EOF').toString('base64')};
 const catalog=(docId=doc.version_id)=>({id:randomUUID(),version_id:randomUUID(),expected_version:0,sku:'SAME-SKU',description:'Synthetic closer',manufacturer:'Synthetic',model:'New',component_type:'closer',currency:'USD',minor_unit_digits:2,unit_price_minor:1234,document_version_ids:[docId]});
 const estimate=(version:string)=>({id:randomUUID(),version_id:randomUUID(),expected_version:0,opening_id:o.id,currency:'USD',minor_unit_digits:2,expires_at:'2099-01-01T00:00:00Z',parts:[{component_id:h.id,catalog_version_id:version,quantity:2}],labor:{kind:'hourly',rate_minor:9000,minutes:90},tax_minor:200,fees_minor:300,tax_note:'Quoted, not computed',fees_note:'Quoted',note:'Synthetic'});
 const context=(token=owner.token)=>request(api).get('/api/commercial/context/'+o.id).set(auth(token));
 return {api,store,owner,provider,other,scope,o,h,auth,post,doc,catalog,estimate,context};
}
it('keeps same SKU distinct across providers and changed document bytes as immutable versions',async()=>{
 const f=await fixture();expect((await f.post('/documents',f.doc)).status).toBe(200);expect((await f.post('/documents',f.doc)).status).toBe(200);
 const changed={...f.doc,version_id:randomUUID(),expected_version:1,pdf_base64:Buffer.from('%PDF-1.4\nChanged evidence\n%%EOF').toString('base64')};expect((await f.post('/documents',changed)).body.sha256).not.toBe((await f.post('/documents',f.doc)).body.sha256);
 const first=f.catalog();expect((await f.post('/catalog',first)).status).toBe(200);
 const secondDoc={...f.doc,id:randomUUID(),version_id:randomUUID()};expect((await f.post('/documents',secondDoc,f.other.token)).status).toBe(200);
 const second=f.catalog(secondDoc.version_id);expect((await f.post('/catalog',second,f.other.token)).status).toBe(200);
 expect((await pool.query('SELECT provider_id FROM provider_catalog_items WHERE sku=$1',['SAME-SKU'])).rows).toHaveLength(2);
 expect((await f.post('/catalog',{...first,description:'changed'})).status).toBe(409);
 expect((await request(f.api).get('/api/commercial/documents/'+f.doc.version_id).set(f.auth(f.other.token))).status).toBe(404);
});
it('snapshots exact prices and document versions, preserves old estimates and rejects missing or expired review',async()=>{
 const f=await fixture();await f.post('/documents',f.doc);const cat=f.catalog();await f.post('/catalog',cat);const quote=f.estimate(cat.version_id);
 const saved=await f.post('/estimates',quote);expect(saved.status).toBe(200);expect(saved.body.snapshot.totals).toMatchObject({total_minor:16468,labor_minor:13500,missing:[]});
 expect((await f.post('/estimates/'+quote.version_id+'/review',{operation_id:randomUUID(),note:'Synthetic review'},f.owner.token)).status).toBe(200);
 expect((await request(f.api).get('/api/commercial/documents/'+f.doc.version_id).set(f.auth(f.owner.token))).status).toBe(200);
 await f.post('/catalog',{...cat,version_id:randomUUID(),expected_version:1,unit_price_minor:9999});
 const old=(await f.context()).body.estimates[0];expect(old.snapshot.parts[0].unit_price_minor).toBe(1234);expect(old.snapshot.document_version_ids).toEqual([f.doc.version_id]);
 const expired={...quote,version_id:randomUUID(),expected_version:1,expires_at:'2000-01-01T00:00:00Z'};expect((await f.post('/estimates',expired)).status).toBe(200);
 expect((await f.post('/estimates/'+expired.version_id+'/review',{operation_id:randomUUID(),note:'Review'},f.owner.token)).body.error).toBe('estimate_expired');
 expect((await f.post('/estimates/'+quote.version_id+'/review',{operation_id:randomUUID(),note:'Review'},f.owner.token)).body.error).toBe('estimate_superseded');
 expect((await f.context()).body.estimates.find((e:any)=>e.id===expired.version_id).stale).toBe(true);
 const missing=f.estimate(cat.version_id);missing.tax_minor=null as any;expect((await f.post('/estimates',missing)).body.snapshot.totals.total_minor).toBeNull();expect((await f.post('/estimates/'+missing.version_id+'/review',{operation_id:randomUUID(),note:'Review'},f.owner.token)).body.error).toBe('estimate_missing_price');
});
it('denies wrong tenants and revoked providers; object corruption or missing storage cannot support review',async()=>{
 const f=await fixture();await f.post('/documents',f.doc);const cat=f.catalog();await f.post('/catalog',cat);const quote=f.estimate(cat.version_id);await f.post('/estimates',quote);
 expect((await f.context(f.other.token)).status).toBe(404);expect((await f.post('/estimates',f.estimate(cat.version_id),f.other.token)).status).toBe(404);
 const broken:CommercialStore={privateImmutable:true,mode:'fixture',putOnce:async()=>{},read:async()=>Buffer.from('tampered')};const bad=createApp({commercialStore:broken});
 expect((await request(bad).post('/api/commercial/estimates/'+quote.version_id+'/review').set(f.auth(f.owner.token)).send({operation_id:randomUUID(),note:'Review'})).body.error).toBe('document_integrity_failed');
 expect((await request(createApp()).post('/api/commercial/documents').set(f.auth(f.provider.token)).send({...f.doc,id:randomUUID(),version_id:randomUUID()})).status).toBe(503);
 expect((await f.post('/catalog',{...cat,id:randomUUID(),version_id:randomUUID(),sku:'MISSING',document_version_ids:[randomUUID()]})).status).toBe(409);
 await request(f.api).put(`/api/provider-assignments/${f.scope.propertyId}/${f.provider.organizationId}`).set(f.auth(f.owner.token)).send({active:false});
 expect((await f.post('/estimates',quote)).status).toBe(404);expect((await f.post('/estimates/'+quote.version_id+'/review',{operation_id:randomUUID(),note:'Review'},f.owner.token)).body.error).toBe('provider_assignment_revoked');
});
it('uses exact minor-unit labor arithmetic and preserves missing prices',()=>{
 expect(estimateTotals([{quantity:1,unit_price_minor:null}],{kind:'fixed',amount_minor:null},null,null)).toMatchObject({total_minor:null,missing:['part_1_price','labor','tax','fees']});
 expect(()=>estimateTotals([],{kind:'hourly',rate_minor:100,minutes:1},0,0)).toThrow('labor_fractional_minor_unit');
 expect(estimateTotals([],{kind:'fixed',amount_minor:2},0,0).total_minor).toBe(2);
});
it('binds review retries and retains the existing whole-opening purchasing gate',async()=>{
 const f=await fixture();await f.post('/documents',f.doc);const cat=f.catalog();await f.post('/catalog',cat);const quote=f.estimate(cat.version_id);await f.post('/estimates',quote);
 const command={operation_id:randomUUID(),note:'Synthetic review'},path='/estimates/'+quote.version_id+'/review';
 const first=await f.post(path,command,f.owner.token);expect(first.status).toBe(200);expect((await f.post(path,command,f.owner.token)).body).toEqual(first.body);
 expect((await f.post(path,{...command,note:'changed'},f.owner.token)).status).toBe(409);
 expect((await pool.query('SELECT count(*) FROM estimate_reviews WHERE estimate_version_id=$1',[quote.version_id])).rows[0].count).toBe('1');
 await request(f.api).put('/api/purchasing/approvals/'+f.h.id).set(f.auth(f.owner.token)).send({document_url:'https://synthetic.invalid/technical-proof',document_sha256:'a'.repeat(64),provenance:'technician_selected',active:false});
 expect((await f.post(path,{...command,operation_id:randomUUID()},f.owner.token)).body.error).toBe('whole_opening_review_required');
 const missingStore:CommercialStore={privateImmutable:true,mode:'fixture',putOnce:async()=>{},read:async()=>{throw Error('missing');}};
 expect((await request(createApp({commercialStore:missingStore})).get('/api/commercial/documents/'+f.doc.version_id).set(f.auth(f.provider.token))).body.error).toBe('document_object_unavailable');
 const before=process.env.CORS_ORIGINS;process.env.CORS_ORIGINS='https://allowed.synthetic.invalid';const corsApp=createApp({commercialStore:f.store});process.env.CORS_ORIGINS=before;
 const response=await request(corsApp).get('/api/commercial/context/'+f.o.id).set(f.auth(f.owner.token)).set('Origin','https://allowed.synthetic.invalid');expect(response.headers['access-control-allow-origin']).toBe('https://allowed.synthetic.invalid');
});
it('links verified private warranty versions to appended lifecycle records without promoting legacy text',async()=>{
 const f=await fixture(),doc={...f.doc,id:randomUUID(),version_id:randomUUID(),property_id:f.scope.propertyId,kind:'warranty',title:'Synthetic warranty'};expect((await f.post('/documents',doc)).status).toBe(200);
 const unknown={certainty:'unknown',precision:'unknown',year:null,month:null,day:null};
 const payload={component_id:f.h.id,warranty_type:'product',record_status:'documented',issuer:'Synthetic',terms:'Quoted terms',start_trigger:'',start_date:unknown,stated_expiry:unknown,exclusions:'',claim_instructions:'',proof_reference:'Synthetic proof',source_reference:'Synthetic provider',note:'',correction_of:null,correction_reason:'',proof_document_version_id:doc.version_id};
 const context=await request(f.api).get('/api/lifecycle/'+f.o.id).set(f.auth(f.owner.token));
 const b={operation_id:randomUUID(),entity_id:randomUUID(),opening_id:f.o.id,device_id:randomUUID(),schema_version:3,app_version:'test',protocol_version:1,expected_revision:context.body.revision,payload};
 expect((await request(f.api).post('/api/lifecycle/warranty').set(f.auth(f.owner.token)).send(b)).status).toBe(201);
 expect((await pool.query('SELECT * FROM commercial_document_links WHERE lifecycle_record_id=$1',[b.entity_id])).rows[0].document_version_id).toBe(doc.version_id);
 expect((await request(f.api).get('/api/commercial/documents/'+doc.version_id).set(f.auth(f.other.token))).status).toBe(404);
});
