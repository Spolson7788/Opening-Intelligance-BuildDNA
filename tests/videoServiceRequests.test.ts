import {expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {pool} from '../src/db/pool';
async function fixture(){
 const owner=await signupTestOrg(),provider=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token);
 const opening=await createTestOpening(owner.token,scope.buildingId,{opening_configuration:'pair'}),auth={Authorization:`Bearer ${owner.token}`};
 expect((await request(app).put(`/api/provider-assignments/${scope.propertyId}/${provider.organizationId}`).set(auth).send({active:true})).status).toBe(200);
 const leaf=(await request(app).post(`/api/openings/${opening.id}/door-leaves`).set(auth).send({leaf_role:'inactive',condition:'worn'})).body;
 const hardware=(await request(app).post('/api/hardware').set(auth).send({opening_id:opening.id,component_type:'closer',mounting_scope:'door_leaf',door_leaf_id:leaf.id,condition:'worn'})).body;
 const body={operation_id:randomUUID(),entity_id:randomUUID(),opening_id:opening.id,device_id:randomUUID(),schema_version:3,app_version:'test',protocol_version:1,
  payload:{symptom:'Inactive leaf does not close',impact:'Door stays open',priority:'high',provider_organization_id:provider.organizationId,uncertain_target:false,targets:[{type:'component',id:hardware.id}],photo_ids:[] as string[]}};
 return {owner,provider,scope,opening,auth,leaf,hardware,body};
}
it('records an incomplete paired-opening request once without claiming completed work, notification, or purchasing',async()=>{
 const f=await fixture();const before=(await pool.query('SELECT completion_state,last_service_date FROM openings WHERE id=$1',[f.opening.id])).rows[0];
 const submit=()=>request(app).post('/api/service-requests').set(f.auth).send(f.body);
 const first=await submit();expect(first.status).toBe(201);expect(first.body.response_payload).toMatchObject({status:'submitted',notification_status:'disabled',targets:[{type:'component',id:f.hardware.id}]});
 expect((await submit()).body).toEqual(first.body);
 expect((await request(app).post('/api/service-requests').set(f.auth).send({...f.body,payload:{...f.body.payload,symptom:'Changed'}})).status).toBe(409);
 expect((await pool.query('SELECT count(*) FROM service_requests WHERE opening_id=$1',[f.opening.id])).rows[0].count).toBe('1');
 expect((await pool.query('SELECT completion_state,last_service_date FROM openings WHERE id=$1',[f.opening.id])).rows[0]).toEqual(before);
 expect((await pool.query('SELECT count(*) FROM service_events WHERE opening_id=$1',[f.opening.id])).rows[0].count).toBe('0');
 const context=await request(app).get('/api/service-requests/context/'+f.opening.id).set(f.auth);expect(context.status).toBe(200);expect(context.body.door_leaves[0].leaf_role).toBe('inactive');expect(context.body.requests).toHaveLength(1);
 expect((await request(app).delete('/api/hardware/'+f.hardware.id).set(f.auth)).status).toBe(409);
});
it('revalidates provider and requester access before receipt replay and rejects foreign targets',async()=>{
 const f=await fixture(),other=await createTestOpening(f.owner.token,f.scope.buildingId);
 const foreign=(await request(app).post('/api/hardware').set(f.auth).send({opening_id:other.id,component_type:'closer'})).body;
 expect((await request(app).post('/api/service-requests').set(f.auth).send({...f.body,payload:{...f.body.payload,targets:[{type:'component',id:foreign.id}]}})).status).toBe(409);
 const providerAuth={Authorization:`Bearer ${f.provider.token}`};
 expect((await request(app).post('/api/service-requests').set(providerAuth).send(f.body)).status).toBe(201);
 expect((await request(app).put(`/api/provider-assignments/${f.scope.propertyId}/${f.provider.organizationId}`).set(f.auth).send({active:false})).status).toBe(200);
 expect((await request(app).post('/api/service-requests').set(providerAuth).send(f.body)).status).toBe(404);
 expect((await request(app).post('/api/service-requests').set(f.auth).send({...f.body,operation_id:randomUUID(),entity_id:randomUUID()})).status).toBe(403);
 const stranger=await signupTestOrg();expect((await request(app).get('/api/service-requests/context/'+f.opening.id).set('Authorization',`Bearer ${stranger.token}`)).status).toBe(404);
 expect((await request(app).get('/api/service-requests/context/'+f.opening.id)).status).toBe(401);
});
it('accepts only verified photographs attributed to selected targets and preserves existing photo deletion',async()=>{
 const f=await fixture();
 const addPhoto=async(target:string,state:string)=> (await pool.query("INSERT INTO photos(opening_id,related_entity_type,related_entity_id,storage_url,upload_state) VALUES($1,'hardware_component',$2,'private/test',$3) RETURNING id",[f.opening.id,target,state])).rows[0].id;
 const unverified=await addPhoto(f.hardware.id,'reserved');
 expect((await request(app).post('/api/service-requests').set(f.auth).send({...f.body,payload:{...f.body.payload,photo_ids:[unverified]}})).status).toBe(409);
 const other=(await request(app).post('/api/hardware').set(f.auth).send({opening_id:f.opening.id,component_type:'hinge'})).body;
 const wrong=await addPhoto(other.id,'verified');
 expect((await request(app).post('/api/service-requests').set(f.auth).send({...f.body,payload:{...f.body.payload,photo_ids:[wrong]}})).status).toBe(409);
 const photo=await addPhoto(f.hardware.id,'verified');f.body.payload.photo_ids=[photo];
 const saved=await request(app).post('/api/service-requests').set(f.auth).send(f.body);expect(saved.status).toBe(201);
 await pool.query('DELETE FROM photos WHERE id=$1',[photo]);
 expect((await pool.query('SELECT count(*) FROM service_request_photos WHERE request_id=$1',[f.body.entity_id])).rows[0].count).toBe('0');
 expect((await pool.query('SELECT response_payload FROM sync_operation_receipts WHERE operation_id=$1',[f.body.operation_id])).rows[0].response_payload.photo_ids).toEqual([photo]);
});
it('blocks retired requests and supports explicit uncertain opening-level intent',async()=>{
 const f=await fixture();
 const uncertain={...f.body,payload:{...f.body.payload,uncertain_target:true,targets:[]}};
 expect((await request(app).post('/api/service-requests').set(f.auth).send(uncertain)).status).toBe(201);
 await pool.query("UPDATE openings SET status='decommissioned' WHERE id=$1",[f.opening.id]);
 expect((await request(app).post('/api/service-requests').set(f.auth).send({...uncertain,operation_id:randomUUID(),entity_id:randomUUID()})).status).toBe(409);
});
it('permits the existing non-bypass API role while keeping browser roles without access',async()=>{
 const f=await fixture();const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const user=(await client.query('SELECT id FROM users WHERE organization_id=$1',[f.owner.organizationId])).rows[0];
  await client.query('SET LOCAL ROLE oi_pr2_api');
  await client.query("INSERT INTO service_requests(id,opening_id,requesting_organization_id,created_by_user_id,provider_organization_id,symptom,impact,priority,uncertain_target) VALUES($1,$2,$3,$4,$5,'test','','normal',true)",[f.body.entity_id,f.opening.id,f.owner.organizationId,user.id,f.provider.organizationId]);
  expect((await client.query('SELECT id FROM service_requests WHERE id=$1',[f.body.entity_id])).rows[0].id).toBe(f.body.entity_id);
  await client.query('RESET ROLE');
  await client.query('CREATE ROLE oi_video_browser_test NOLOGIN');
  await client.query('GRANT SELECT,INSERT ON service_requests TO oi_video_browser_test');
  await client.query('SET LOCAL ROLE oi_video_browser_test');
  expect((await client.query('SELECT id FROM service_requests WHERE id=$1',[f.body.entity_id])).rows).toEqual([]);
  // Catch the expected RLS refusal inside SQL: this socket adapter mishandles
  // error frames followed by another client query in the same transaction.
  await client.query(`DO $$ BEGIN
    INSERT INTO service_requests(id,opening_id,requesting_organization_id,created_by_user_id,provider_organization_id,symptom,impact,priority,uncertain_target)
    VALUES('${randomUUID()}','${f.opening.id}','${f.owner.organizationId}','${user.id}','${f.provider.organizationId}','blocked','','normal',true);
    RAISE EXCEPTION 'browser insert unexpectedly allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
  END $$`);
  await client.query('ROLLBACK');
  const tables=await client.query("SELECT relrowsecurity FROM pg_class WHERE relname IN ('service_requests','service_request_targets','service_request_photos')");expect(tables.rows).toHaveLength(3);expect(tables.rows.every(r=>r.relrowsecurity)).toBe(true);
 }finally{await client.query('ROLLBACK');client.release();}
});
