import {it,expect} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';
import {pool} from '../src/db/pool';

it('known identity requires acknowledgment, records the signed-in technician, and permits a department request without recognition or admin approval',async()=>{
 const org=await signupTestOrg(), f=await createPortfolioHierarchy(org.token),o=await createTestOpening(org.token,f.buildingId);
 const auth={Authorization:`Bearer ${org.token}`};
 await pool.query("UPDATE users SET role='technician' WHERE organization_id=$1",[org.organizationId]);
 const user=(await pool.query('SELECT id FROM users WHERE organization_id=$1',[org.organizationId])).rows[0];
 const body={opening_id:o.id,component_type:'closer',manufacturer:'LCN',model_number:'4040XP',identity_source:'technician_identified',identity_status:'established',condition:'worn',review_state:'reviewed',replacement_required:true};
 expect((await request(app).post('/api/hardware').set(auth).send(body)).status).toBe(400);
 const saved=await request(app).post('/api/hardware').set(auth).send({...body,identity_acknowledged:true,identity_acknowledged_by:randomUUID()});
 expect(saved.status).toBe(201);
 expect(saved.body).toMatchObject({identity_source:'technician_identified',identity_acknowledged_by:user.id,identity_recognition_run_id:null});
 expect(saved.body.identity_acknowledged_at).toBeTruthy();
 const purchase={request_id:randomUUID(),opening_id:o.id,recipient_email:'purchasing@example.test',acknowledged:true};
 expect((await request(app).post('/api/purchasing/requests').set(auth).send(purchase)).status).toBe(409);
 await request(app).put(`/api/openings/${o.id}/frame`).set(auth).send({material:'Steel',condition:'good'});
 await request(app).post(`/api/openings/${o.id}/door-leaves`).set(auth).send({leaf_role:'single',condition:'good'});
 expect((await request(app).post(`/api/openings/${o.id}/complete`).set(auth)).status).toBe(200);
 const prepared=await request(app).post('/api/purchasing/requests').set(auth).send(purchase);
 expect(prepared.status).toBe(201);expect(prepared.body.email.body).toContain('technician_identified');
 for(const table of ['recognition_runs','component_purchasing_approvals']){
 const column=table==='recognition_runs'?'opening_id':'component_id';
 expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`,[table==='recognition_runs'?o.id:saved.body.id])).rows[0].n).toBe(0);
 }
 const edited=await request(app).patch('/api/hardware/'+saved.body.id).set(auth).send({model_number:'4041DA'});
 expect(edited.status).toBe(200);expect(edited.body).toMatchObject({identity_source:'unknown',identity_acknowledged_at:null,identity_acknowledged_by:null,identity_status:'unresolved'});
 expect((await request(app).post('/api/purchasing/requests').set(auth).send({...purchase,request_id:randomUUID()})).status).toBe(409);
 const confirmed=await request(app).patch('/api/hardware/'+saved.body.id).set(auth).send({identity_source:'technician_identified',identity_acknowledged:true,identity_status:'established',review_state:'reviewed'});
 expect(confirmed.status).toBe(200);expect(confirmed.body.identity_acknowledged_by).toBe(user.id);
});

it('offline known identity replays without changing attribution or producing recognition work',async()=>{
 const org=await signupTestOrg(),f=await createPortfolioHierarchy(org.token),o=await createTestOpening(org.token,f.buildingId),auth={Authorization:`Bearer ${org.token}`};
 const body={operation_id:randomUUID(),entity_id:randomUUID(),opening_id:o.id,device_id:randomUUID(),base_server_revision:null,schema_version:3,app_version:'identity-test',protocol_version:1,payload:{component_type:'closer',mounting_scope:'opening',manufacturer:'Cal-Royal',model_number:'CR441',identity_source:'technician_identified',identity_acknowledged:true,identity_status:'established',condition:'worn',review_state:'reviewed',replacement_required:true}};
 const save=()=>request(app).post('/api/sync/components').set(auth).send(body);
 expect((await save()).status).toBe(201);
 const first=(await pool.query('SELECT * FROM hardware_components WHERE id=$1',[body.entity_id])).rows[0];
 expect(first.identity_source).toBe('technician_identified');expect(first.identity_acknowledged_at).toBeTruthy();expect(first.identity_recognition_run_id).toBeNull();
 expect((await save()).status).toBe(200);
 const second=(await pool.query('SELECT * FROM hardware_components WHERE id=$1',[body.entity_id])).rows[0];
 expect(second.identity_acknowledged_at).toEqual(first.identity_acknowledged_at);
 const rejected=await request(app).post('/api/sync/components').set(auth).send({...body,operation_id:randomUUID(),entity_id:randomUUID(),payload:{...body.payload,identity_source:'photo_suggestion',recognition_run_id:randomUUID()}});
 expect(rejected.status).toBe(400);expect(rejected.body.error).toBe('invalid_recognition_run');
 expect((await pool.query('SELECT count(*)::int n FROM recognition_runs WHERE opening_id=$1',[o.id])).rows[0].n).toBe(0);
 expect((await request(app).post('/api/hardware').set(auth).send({opening_id:o.id,component_type:'closer',manufacturer:'LCN',model_number:'4040XP',identity_source:'photo_suggestion',identity_acknowledged:true,recognition_run_id:randomUUID()})).status).toBe(400);
});

it('catalog offers only approved citable product references and requires authentication',async()=>{
 const org=await signupTestOrg(),auth={Authorization:`Bearer ${org.token}`},sha=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 await pool.query("INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status) VALUES($1,'SYNTHETIC','Identity QA','Synthetic product','installation',1,'synthetic.pdf','{}','draft')",[sha]);
 await pool.query("INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable) VALUES($1,1,'Synthetic identity model', $1,'text','none',true)",[sha]);
 await pool.query("INSERT INTO reference_document_models(doc_sha256,model,evidence_page,evidence_quote) VALUES($1,'QA-CLOSER',1,'Synthetic identity model')",[sha]);
 const get=()=>request(app).get('/api/hardware/catalog?q=Identity%20QA').set(auth);
 expect((await request(app).get('/api/hardware/catalog')).status).toBe(401);
 expect((await get()).body.products).toEqual([]);
 await pool.query("UPDATE reference_documents SET status='approved',approved_at=now(),approved_by=(SELECT id FROM users WHERE organization_id=$2 LIMIT 1) WHERE sha256=$1",[sha,org.organizationId]);
 expect((await get()).body.products).toContainEqual({manufacturer:'Identity QA',model_number:'QA-CLOSER',series:null});
 await pool.query("UPDATE reference_pages SET citable=false WHERE doc_sha256=$1",[sha]);
 expect((await get()).body.products).toEqual([]);
});
