import {it,expect} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app';
import {pool} from '../src/db/pool';
import {signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {conditionCohorts} from '../src/services/planningProjection';
import {canonicalPayloadHash} from '../src/services/syncProtocol';
async function setup(){
 const owner=await signupTestOrg(),other=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token),o=await createTestOpening(owner.token,scope.buildingId),api=createApp({planningSandboxEnabled:true});
 const actor=(await pool.query('SELECT id FROM users WHERE email=$1',[owner.email])).rows[0].id,id=randomUUID(),version=randomUUID();
 await pool.query('INSERT INTO replacement_estimates(id,provider_id,opening_id,head_version) VALUES($1,$2,$3,1)',[id,owner.organizationId,o.id]);
 const snapshot={expires_at:'2099-01-01T00:00:00Z',totals:{total_minor:null,missing:['labor']},currency:'USD',minor_unit_digits:2};
 await pool.query('INSERT INTO replacement_estimate_versions(id,estimate_id,version,snapshot,recorded_by,request_hash) VALUES($1,$2,1,$3,$4,$5)',[version,id,JSON.stringify(snapshot),actor,'fixture']);
 const b={id:randomUUID(),version_id:randomUUID(),expected_version:0,opening_id:o.id,kind:'order',estimate_version_id:version,label:'Synthetic draft',fiscal_period:'',assumptions:'No terms or authority agreed'};
 const post=(path:string,body:any,token=owner.token)=>request(api).post('/api/planning'+path).set('Authorization','Bearer '+token).send(body);
 return {owner,other,o,api,b,post};
}
it('binds sandbox revisions to owner, payload and exact immutable quote; defaults off',async()=>{
 const f=await setup();expect((await request(createApp()).post('/api/planning/versions').set('Authorization','Bearer '+f.owner.token).send(f.b)).status).toBe(503);
 expect((await f.post('/versions',f.b,f.other.token)).status).toBe(404);
 const first=await f.post('/versions',f.b);expect(first.status).toBe(200);expect(first.body.snapshot_hash).toBe(canonicalPayloadHash(first.body.snapshot));
 expect(first.body.snapshot.estimate.totals.total_minor).toBeNull();expect(first.body.snapshot.financial_authority).toBe(false);
 expect((await f.post('/versions',f.b)).body).toEqual(first.body);expect((await f.post('/versions',{...f.b,label:'Changed'})).status).toBe(409);
 expect((await f.post('/versions',{...f.b,version_id:randomUUID(),expected_version:0})).status).toBe(409);
 expect((await request(f.api).get('/api/planning/'+f.o.id).set('Authorization','Bearer '+f.other.token)).status).toBe(404);
});
it('atomically records review and disabled outbox, supersedes unsent revisions without issuing',async()=>{
 const f=await setup();await f.post('/versions',f.b);const operation_id=randomUUID(),path='/versions/'+f.b.version_id+'/request-review';
 const first=await f.post(path,{operation_id});expect(first.status).toBe(200);expect((await f.post(path,{operation_id})).body).toEqual(first.body);
 expect((await pool.query('SELECT * FROM sandbox_delivery_holds WHERE version_id=$1',[f.b.version_id])).rows).toHaveLength(1);
 const newer={...f.b,version_id:randomUUID(),expected_version:1,label:'Revised'};expect((await f.post('/versions',newer)).status).toBe(200);
 expect((await f.post(path,{operation_id:randomUUID()})).status).toBe(409);
 const view=await request(f.api).get('/api/planning/'+f.o.id).set('Authorization','Bearer '+f.owner.token);expect(view.status).toBe(200);
 expect(view.body.versions.find((v:any)=>v.id===f.b.version_id).delivery_state).toBe('superseded');expect(view.body.financial.combined_total_minor).toBeNull();
 expect(view.body.events).toHaveLength(3);expect(view.body.versions.every((v:any)=>v.snapshot.business_state==='draft')).toBe(true);
 await expect(pool.query("UPDATE sandbox_plan_versions SET snapshot='{}' WHERE id=$1",[f.b.version_id])).rejects.toThrow();
});
it('keeps scenarios separate and historical estimates immutable without creating reservations',async()=>{
 const f=await setup(),b={...f.b,kind:'scenario',fiscal_period:'FY2027'};expect((await f.post('/versions',{...b,fiscal_period:' '})).status).toBe(422);expect((await f.post('/versions',b)).status).toBe(200);
 expect((await f.post('/versions/'+b.version_id+'/request-review',{operation_id:randomUUID()})).status).toBe(409);
 const view=await request(f.api).get('/api/planning/'+f.o.id).set('Authorization','Bearer '+f.owner.token);
 expect(view.body.financial.approved_reservation_minor).toBeNull();expect(view.body.versions[0].snapshot.fiscal_period).toBe('FY2027');expect(view.body.lifecycle.exposure_component_years).toBeNull();
 await pool.query('UPDATE replacement_estimates SET head_version=2 WHERE id=(SELECT estimate_id FROM replacement_estimate_versions WHERE id=$1)',[b.estimate_version_id]);
 const changed=await request(f.api).get('/api/planning/'+f.o.id).set('Authorization','Bearer '+f.owner.token);
 expect(changed.body.versions[0].estimate_currently_superseded).toBe(true);expect(changed.body.versions[0].snapshot.estimate_superseded_at_draft).toBe(false);
});
it('withholds small cohorts and excludes unverified, retired and material labels without merging models',()=>{
 const h={lifecycle_state:'active',manufacturer:'Cal-Royal',model_number:'CR441',component_type:'closer',condition:'good'};
 expect(conditionCohorts([h,{...h,condition:'worn'}]).cohorts[0].rate).toBeNull();
 const eleven=Array.from({length:11},()=>({...h}));expect(conditionCohorts(eleven).cohorts[0].rate).toBeNull();
 const twelve=conditionCohorts([...eleven,{...h,condition:'failed'},{...h,condition:'unverified'},{...h,lifecycle_state:'retired',condition:'failed'},{...h,manufacturer:'Steel'},{...h,model_number:'Other'}]);
 expect(twelve.cohorts[0]).toMatchObject({assessed:12,worn_failed:1,unverified:1,rate:1/12});expect(twelve.cohorts).toHaveLength(2);expect(twelve.excluded_manufacturer_count).toBe(1);
});
