import {expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {pool} from '../src/db/pool';
import {downtimeSummary} from '../src/services/lifecycleRecords';
const unknown={certainty:'unknown',precision:'unknown',year:null,month:null,day:null};
const boundary=(a:string|null,b=a)=>({certainty:a===null?'unknown':a===b?'confirmed':'estimated',earliest:a,latest:b});
async function fixture(){
 const owner=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token),o=await createTestOpening(owner.token,scope.buildingId,{opening_configuration:'pair'}),auth={Authorization:`Bearer ${owner.token}`};
 await request(app).put('/api/openings/'+o.id+'/frame').set(auth).send({condition:'good'});
 const parts=[];for(const role of ['active','inactive']){const leaf=(await request(app).post('/api/openings/'+o.id+'/door-leaves').set(auth).send({leaf_role:role,condition:'good'})).body;const h=await request(app).post('/api/hardware').set(auth).send({opening_id:o.id,component_type:'closer',mounting_scope:'door_leaf',door_leaf_id:leaf.id,condition:role==='inactive'?'failed':'good',review_state:'reviewed',replacement_required:role==='inactive',unit_cost:role==='inactive'?50:10,warranty_expiration:'2027-01-01'});expect(h.status).toBe(201);parts.push(h.body);}
 expect((await request(app).post('/api/openings/'+o.id+'/complete').set(auth)).status).toBe(200);
 const context=()=>request(app).get('/api/lifecycle/'+o.id).set(auth);
 const command=async(payload:any)=>({operation_id:randomUUID(),entity_id:randomUUID(),opening_id:o.id,device_id:randomUUID(),schema_version:3,app_version:'test',protocol_version:1,expected_revision:(await context()).body.revision,payload});
 const submit=(kind:string,b:any,a=auth)=>request(app).post('/api/lifecycle/'+kind).set(a).send(b);
 const replacement=async()=>{const successor=randomUUID();return command({predecessor_id:parts[1].id,expected_component_revision:Number(parts[1].revision),successor_id:successor,position_key:'top closer',manufacturer:'Synthetic',model_number:'Replacement',serial_number:'',installation:{target:{type:'component',id:successor},date:unknown,source_type:'unknown',source_reference:'',note:'Synthetic',correction_of:null,correction_reason:''}});};
 return {owner,scope,o,auth,parts,context,command,submit,replacement};
}
it('replaces the inactive closer atomically, preserving old service/warranty while current gates and costs use only active instances',async()=>{
 const f=await fixture();const service=(await request(app).post('/api/events/service-events').set(f.auth).send({opening_id:f.o.id,hardware_component_id:f.parts[1].id,event_date:'2020-01-01',work_performed:'Historical job',cost:125})).body;
 const b=await f.replacement(),first=await f.submit('replacements',b);expect(first.status).toBe(201);expect((await f.submit('replacements',b)).body).toEqual(first.body);
 const context=(await f.context()).body,old=context.hardware_components.find((h:any)=>h.id===f.parts[1].id),fresh=context.hardware_components.find((h:any)=>h.id===b.payload.successor_id);
 expect(old.lifecycle_state).toBe('retired');expect(old.warranty_expiration).toBe('2027-01-01');expect(old.tracker_id).toBe(f.parts[1].tracker_id);
 expect(fresh).toMatchObject({lifecycle_state:'active',supersedes_component_id:old.id,door_leaf_id:old.door_leaf_id,position_id:old.position_id});expect(fresh.tracker_id).not.toBe(old.tracker_id);
 expect(context.service_events).toHaveLength(1);expect(context.service_events[0]).toMatchObject({id:service.id,cost:125,hardware_component_id:old.id});
 expect((await request(app).post('/api/openings/'+f.o.id+'/complete').set(f.auth)).status).toBe(409);
 expect((await request(app).patch('/api/hardware/'+fresh.id).set(f.auth).send({expected_revision:1,condition:'good',review_state:'reviewed'})).status).toBe(200);
 expect((await request(app).post('/api/openings/'+f.o.id+'/complete').set(f.auth)).status).toBe(200);
 expect((await request(app).put('/api/purchasing/approvals/'+fresh.id).set(f.auth).send({document_url:'https://synthetic.invalid/proof',document_sha256:'a'.repeat(64),provenance:'technician_selected',active:true})).status).toBe(409);
 const purchase=(await request(app).post('/api/purchasing/review').set(f.auth).send({opening_ids:[f.o.id]})).body;expect(purchase.blocked).toBe(false);expect(purchase.decisions.map((d:any)=>d.component_id)).not.toContain(old.id);
 const dashboard=(await request(app).get('/api/portfolio/facility-dashboard/'+f.scope.propertyId).set(f.auth)).body.openings[0];expect(dashboard.hardware_components).toHaveLength(2);expect(dashboard.retired_hardware_components[0].id).toBe(old.id);expect(dashboard.service_events).toHaveLength(1);
 const forecast=(await request(app).get('/api/portfolio/capital-forecast?property_id='+f.scope.propertyId).set(f.auth)).body;expect(forecast.buckets.unassessed.known_cost_total).toBe(10);
 expect((await request(app).get('/api/service-requests/context/'+f.o.id).set(f.auth)).body.hardware_components.map((h:any)=>h.id)).not.toContain(old.id);
 expect((await request(app).get('/api/openings/'+f.o.id).set(f.auth)).body.hardware_components).toHaveLength(2);
 expect((await request(app).patch('/api/hardware/'+old.id).set(f.auth).send({expected_revision:Number(old.revision),condition:'good'})).status).toBe(409);
});
it('rejects changed retries, stale predecessor, unauthorized replacement, and remounting positioned successors',async()=>{
 const f=await fixture(),b=await f.replacement(),other=await signupTestOrg();expect((await f.submit('replacements',b,{Authorization:`Bearer ${other.token}`})).status).toBe(404);
 expect((await f.submit('replacements',{...b,payload:{...b.payload,expected_component_revision:999}})).status).toBe(409);
 expect((await f.submit('replacements',b)).status).toBe(201);
 expect((await f.submit('replacements',{...b,payload:{...b.payload,model_number:'changed'}})).status).toBe(409);
 expect((await f.submit('replacements',{...b,operation_id:randomUUID(),entity_id:randomUUID(),expected_revision:(await f.context()).body.revision})).status).toBe(409);
 expect((await request(app).patch('/api/hardware/'+b.payload.successor_id).set(f.auth).send({expected_revision:1,door_leaf_id:f.parts[0].door_leaf_id})).status).toBe(409);
 const count=await pool.query("SELECT count(*) FROM hardware_components WHERE position_id=(SELECT position_id FROM hardware_components WHERE id=$1) AND lifecycle_state='active'",[b.payload.successor_id]);expect(count.rows[0].count).toBe('1');
});
it('unions downtime overlaps once and retains uncertain bounds separately',()=>{
 const row=(start:any,end:any,availability='unavailable')=>({kind:'downtime',is_current:true,payload:{start,end,availability}});
 const a='2020-01-01T00:00:00Z',b='2020-01-01T01:00:00Z',c='2020-01-01T02:00:00Z',d='2020-01-01T03:00:00Z';
 expect(downtimeSummary([row(boundary(a),boundary(c)),row(boundary(b),boundary(d))]).unavailable).toMatchObject({guaranteed_minutes:180,possible_minutes:180});
 expect(downtimeSummary([row(boundary(a,b),boundary(c,d))]).unavailable).toMatchObject({guaranteed_minutes:60,possible_minutes:180,estimated_intervals:1});
 expect(downtimeSummary([row(boundary(a),boundary(null))]).unavailable).toMatchObject({guaranteed_minutes:0,possible_minutes:null,unresolved_intervals:1});
});
it('persists multi-component downtime once and appends closing corrections without service-cost duplication',async()=>{
 const f=await fixture(),p={component_ids:f.parts.map(h=>h.id),availability:'unavailable',start:boundary('2020-01-01T00:00:00Z'),end:boundary(null),impact:'Synthetic',source_reference:'Synthetic log',note:'',correction_of:null,correction_reason:''};
 const b=await f.command(p);expect((await f.submit('downtime',b)).status).toBe(201);expect((await f.submit('downtime',b)).status).toBe(200);
 const correction=await f.command({...p,correction_of:b.entity_id,correction_reason:'End verified',end:boundary('2020-01-01T02:00:00Z')});expect((await f.submit('downtime',correction)).status).toBe(201);
 const c=(await f.context()).body;expect(c.downtime.unavailable.guaranteed_minutes).toBe(120);expect(c.records).toHaveLength(2);expect(c.records.filter((r:any)=>r.is_current)).toHaveLength(1);expect(c.service_events).toHaveLength(0);
 expect((await f.submit('downtime',await f.command({...p,end:boundary('2019-01-01T00:00:00Z')}))).status).toBe(422);
 expect((await f.submit('downtime',await f.command({...p,component_ids:[randomUUID()]}))).status).toBe(409);
});
it('keeps product and labor terms on the original instance after replacement, without coverage inference',async()=>{
 const f=await fixture(),p={component_id:f.parts[1].id,warranty_type:'product',record_status:'unknown',issuer:'',terms:'',start_trigger:'',start_date:unknown,stated_expiry:unknown,exclusions:'',claim_instructions:'',proof_reference:'',source_reference:'Unknown evidence',note:'',correction_of:null,correction_reason:''};
 expect((await f.submit('warranty',await f.command(p))).status).toBe(201);
 expect((await f.submit('warranty',await f.command({...p,warranty_type:'labor',record_status:'documented',issuer:'Synthetic provider',terms:'Synthetic labor terms only',proof_reference:'Synthetic contract 1'}))).status).toBe(201);
 expect((await f.submit('warranty',await f.command({...p,record_status:'documented'}))).status).toBe(422);
 const b=await f.replacement();expect((await f.submit('replacements',b)).status).toBe(201);
 const c=(await f.context()).body;expect(c.records).toHaveLength(2);expect(c.records.every((r:any)=>r.payload.component_id===f.parts[1].id)).toBe(true);expect(c.records.map((r:any)=>r.payload.warranty_type)).toEqual(['product','labor']);expect(c.records.some((r:any)=>r.payload.coverage_confirmed)).toBe(false);
});
