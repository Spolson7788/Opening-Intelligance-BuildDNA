import {expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {pool} from '../src/db/pool';
import {installationDateSchema} from '../src/services/installationFacts';
async function fixture(){
 const owner=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token);
 const opening=await createTestOpening(owner.token,scope.buildingId,{opening_configuration:'pair',install_date:'2017-04-05'}),auth={Authorization:`Bearer ${owner.token}`};
 const leaf=(await request(app).post(`/api/openings/${opening.id}/door-leaves`).set(auth).send({leaf_role:'inactive',condition:'worn'})).body;
 const hardware=(await request(app).post('/api/hardware').set(auth).send({opening_id:opening.id,component_type:'closer',mounting_scope:'door_leaf',door_leaf_id:leaf.id,install_date:'2018-05-06'})).body;
 const context=()=>request(app).get('/api/lifecycle/'+opening.id).set(auth);
 const revision=(await context()).body.revision;
 const body={operation_id:randomUUID(),entity_id:randomUUID(),opening_id:opening.id,device_id:randomUUID(),schema_version:3,app_version:'wp3-test',protocol_version:1,expected_revision:revision,
 payload:{target:{type:'component',id:hardware.id},date:{certainty:'estimated',precision:'month',year:2018,month:5,day:null},source_type:'recollection',source_reference:'Technician recollection',note:'Approximate',correction_of:null as string|null,correction_reason:''}};
 const submit=(b:any=body,a:any=auth)=>request(app).post('/api/lifecycle/installation-facts').set(a).send(b);
 return {owner,scope,opening,auth,leaf,hardware,body,context,submit};
}
it('validates actual calendar dates and retains uncertainty without fabricated parts',()=>{
 const valid=(d:any)=>installationDateSchema.safeParse(d).success;
 expect(valid({certainty:'confirmed',precision:'day',year:2024,month:2,day:29})).toBe(true);
 expect(valid({certainty:'confirmed',precision:'day',year:2023,month:2,day:29})).toBe(false);
 expect(valid({certainty:'estimated',precision:'month',year:2020,month:4,day:1})).toBe(false);
 expect(valid({certainty:'unknown',precision:'unknown',year:null,month:null,day:null})).toBe(true);
 expect(valid({certainty:'unknown',precision:'year',year:2020,month:null,day:null})).toBe(false);
 expect(valid({certainty:'estimated',precision:'year',year:2020,month:null,day:null})).toBe(true);
});
it('preserves unreviewed legacy dates, original service IDs, and paired attribution',async()=>{
 const f=await fixture();
 const service=await request(app).post('/api/events/service-events').set(f.auth).send({opening_id:f.opening.id,hardware_component_id:f.hardware.id,event_date:'2020-01-01',work_performed:'Historical service'});
 expect(service.status).toBe(201);
 const saved=await f.submit();expect(saved.status).toBe(201);
 const context=(await f.context()).body;
 expect(context.installation_facts[0]).toMatchObject({certainty:'estimated',precision:'month',year:2018,month:5,day:null,target:{type:'component',id:f.hardware.id},is_current:true});
 expect(context.installation_facts[0].recorded_at).toBeTruthy();
 expect(context.legacy_installation_dates.every((v:any)=>v.review_state==='unreviewed')).toBe(true);
 expect(context.legacy_installation_dates).toHaveLength(2);
 expect(context.hardware_components.find((c:any)=>c.id===f.hardware.id).door_leaf_id).toBe(f.leaf.id);
 expect(context.service_events[0].id).toBe(service.body.id);
 expect((await pool.query('SELECT install_date::text FROM hardware_components WHERE id=$1',[f.hardware.id])).rows[0].install_date).toBe('2018-05-06');
});
it('returns original receipt on retry, rejects changed content, and appends corrections',async()=>{
 const f=await fixture(),first=await f.submit();expect(first.status).toBe(201);
 expect((await f.submit()).body).toEqual(first.body);
 expect((await f.submit({...f.body,payload:{...f.body.payload,note:'changed'}})).status).toBe(409);
 const correction={...f.body,operation_id:randomUUID(),entity_id:randomUUID(),expected_revision:(await f.context()).body.revision,payload:{...f.body.payload,correction_of:f.body.entity_id,correction_reason:'Invoice located',date:{certainty:'confirmed',precision:'day',year:2018,month:5,day:14},source_type:'invoice',source_reference:'Synthetic invoice 14'}};
 expect((await f.submit(correction)).status).toBe(201);
 expect((await f.submit(correction)).status).toBe(200);
 const facts=(await f.context()).body.installation_facts;
 expect(facts).toHaveLength(2);expect(facts[0].day).toBeNull();expect(facts[0].is_current).toBe(false);expect(facts[1].correction_of).toBe(facts[0].id);expect(facts[1].is_current).toBe(true);
 expect((await f.submit({...correction,operation_id:randomUUID(),entity_id:randomUUID(),expected_revision:(await f.context()).body.revision})).status).toBe(409);
});
it('rejects stale revisions, foreign targets, invalid certainty and changed correction targets',async()=>{
 const f=await fixture();
 expect((await f.submit({...f.body,expected_revision:f.body.expected_revision+1})).status).toBe(409);
 expect((await f.submit({...f.body,payload:{...f.body.payload,target:{type:'opening',id:randomUUID()}}})).status).toBe(409);
 expect((await f.submit({...f.body,payload:{...f.body.payload,date:{certainty:'confirmed',precision:'year',year:2020,month:null,day:null}}})).status).toBe(422);
 expect((await f.submit()).status).toBe(201);
 expect((await f.submit({...f.body,operation_id:randomUUID(),entity_id:randomUUID(),expected_revision:(await f.context()).body.revision,payload:{...f.body.payload,target:{type:'door_leaf',id:f.leaf.id},correction_of:f.body.entity_id,correction_reason:'Wrong target'}})).status).toBe(409);
});
it('reauthorizes replay after revocation and binds receipts to the recording user',async()=>{
 const f=await fixture(),provider=await signupTestOrg();
 await request(app).put(`/api/provider-assignments/${f.scope.propertyId}/${provider.organizationId}`).set(f.auth).send({active:true});
 const pa={Authorization:`Bearer ${provider.token}`};expect((await f.submit(f.body,pa)).status).toBe(201);
 await request(app).put(`/api/provider-assignments/${f.scope.propertyId}/${provider.organizationId}`).set(f.auth).send({active:false});
 expect((await f.submit(f.body,pa)).status).toBe(404);
 expect((await request(app).get('/api/lifecycle/'+f.opening.id).set(pa)).status).toBe(404);
 const claims=jwt.decode(f.owner.token) as any;
 await pool.query("UPDATE users SET role='viewer' WHERE id=$1",[claims.userId]);
 const viewer=f.owner.token;
 expect((await f.submit(f.body,{Authorization:`Bearer ${viewer}`})).status).toBe(403);
 expect((await request(app).get('/api/lifecycle/'+f.opening.id)).status).toBe(401);
 const other=await signupTestOrg();expect((await request(app).get('/api/lifecycle/'+f.opening.id).set('Authorization',`Bearer ${other.token}`)).status).toBe(404);
});
it('stores unknown installation explicitly and prevents destructive history mutation',async()=>{
 const f=await fixture();f.body.payload.date={certainty:'unknown',precision:'unknown',year:null as any,month:null as any,day:null};
 expect((await f.submit()).status).toBe(201);
 const c=await pool.connect();try{
  await c.query(`DO $$ BEGIN UPDATE installation_facts SET note='erase' WHERE id='${f.body.entity_id}'; RAISE EXCEPTION 'update unexpectedly allowed' USING ERRCODE='XX000'; EXCEPTION WHEN raise_exception THEN NULL; END $$`);
  await c.query(`DO $$ BEGIN DELETE FROM installation_facts WHERE id='${f.body.entity_id}'; RAISE EXCEPTION 'delete unexpectedly allowed' USING ERRCODE='XX000'; EXCEPTION WHEN raise_exception THEN NULL; END $$`);
 }finally{c.release();}
 expect((await f.context()).body.installation_facts[0]).toMatchObject({certainty:'unknown',precision:'unknown',year:null,month:null,day:null,note:'Approximate'});
 expect((await request(app).delete('/api/hardware/'+f.hardware.id).set(f.auth)).status).toBe(409);
});

it('keeps target type in root identity even when entity UUIDs coincide',async()=>{
 const f=await fixture();
 await pool.query('INSERT INTO hardware_components(id,opening_id,component_type,tracker_id) VALUES($1,$1,$2,$3)',[f.opening.id,'hinge',randomUUID()]);
 const first={...f.body,payload:{...f.body.payload,target:{type:'opening',id:f.opening.id}}};
 expect((await f.submit(first)).status).toBe(201);
 const second={...f.body,operation_id:randomUUID(),entity_id:randomUUID(),expected_revision:(await f.context()).body.revision,payload:{...f.body.payload,target:{type:'component',id:f.opening.id}}};
 expect((await f.submit(second)).status).toBe(201);
 expect((await f.context()).body.installation_facts.map((f:any)=>f.target.type)).toEqual(['opening','component']);
});
it('rejects another user replaying a receipt within the same organization',async()=>{
 const f=await fixture();expect((await f.submit()).status).toBe(201);
 const claims=jwt.decode(f.owner.token) as any;
 const id=randomUUID();await pool.query("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic second user','admin','test-only-unusable')",[id,f.owner.organizationId,id+'@example.test']);
 const token=jwt.sign({...claims,userId:id},process.env.JWT_SECRET!);
 expect((await f.submit(f.body,{Authorization:`Bearer ${token}`})).status).toBe(409);
});
