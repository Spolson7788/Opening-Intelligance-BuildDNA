import {it,expect} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {pool} from '../src/db/pool';
import {app,signupTestOrg,createPortfolioHierarchy,createTestOpening} from './helpers';

async function fixture(){
 const owner=await signupTestOrg(),scope=await createPortfolioHierarchy(owner.token),opening=await createTestOpening(owner.token,scope.buildingId,{opening_configuration:'pair'});
 return {owner,opening,auth:{Authorization:`Bearer ${owner.token}`}};
}
async function overlap(table:'openings'|'hardware_components',id:string,start:()=>Promise<any>[]){
 const lock=await pool.connect();let running:Promise<any>[]=[];
 try {
  await lock.query('BEGIN');await lock.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[id]);
  running=start();let waiters=0;
  for(let i=0;i<100;i++){
   const r=await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");waiters=Number(r.rows[0].count);
   if(waiters>=running.length)break;await new Promise(resolve=>setTimeout(resolve,25));
  }
  expect(waiters).toBeGreaterThanOrEqual(running.length);
 } finally {await lock.query('ROLLBACK');lock.release();}
 return Promise.all(running);
}
it('uses independent PostgreSQL connections and serializes duplicate creates and competing revisions',async()=>{
 const clients=await Promise.all([pool.connect(),pool.connect()]);
 try {const ids=await Promise.all(clients.map(c=>c.query('SELECT pg_backend_pid() AS pid')));expect(ids[0].rows[0].pid).not.toBe(ids[1].rows[0].pid);} finally {clients.forEach(c=>c.release());}
 const f=await fixture(),body={opening_id:f.opening.id,component_type:'closer',client_operation_id:randomUUID()};
 const create=()=>request(app).post('/api/hardware').set(f.auth).send(body);
 const duplicates=await overlap('openings',f.opening.id,()=>[create().then(r=>r),create().then(r=>r),create().then(r=>r)]);
 expect(duplicates.map(r=>r.status)).toEqual([201,201,201]);expect(new Set(duplicates.map(r=>r.body.id)).size).toBe(1);
 const id=duplicates[0].body.id;
 const update=(condition:string)=>request(app).patch('/api/hardware/'+id).set(f.auth).send({condition,expected_revision:1,client_operation_id:randomUUID()});
 const competing=await overlap('hardware_components',id,()=>[update('worn').then(r=>r),update('failed').then(r=>r)]);expect(competing.map(r=>r.status).sort()).toEqual([200,409]);
 expect(Number((await pool.query('SELECT revision FROM hardware_components WHERE id=$1',[id])).rows[0].revision)).toBe(2);
 const stranger=await signupTestOrg();expect((await request(app).post('/api/hardware').set('Authorization','Bearer '+stranger.token).send(body)).status).toBe(403);
});
it('serializes simultaneous replacement retries and competing successors with one current instance',async()=>{
 const f=await fixture();const leaf=(await request(app).post('/api/openings/'+f.opening.id+'/door-leaves').set(f.auth).send({leaf_role:'inactive'})).body;
 const component=(await request(app).post('/api/hardware').set(f.auth).send({opening_id:f.opening.id,component_type:'closer',mounting_scope:'door_leaf',door_leaf_id:leaf.id})).body;
 const context=await request(app).get('/api/lifecycle/'+f.opening.id).set(f.auth);
 const successor=randomUUID(),body={operation_id:randomUUID(),entity_id:randomUUID(),opening_id:f.opening.id,device_id:randomUUID(),schema_version:3,app_version:'real-postgres-concurrency',protocol_version:1,expected_revision:context.body.revision,payload:{predecessor_id:component.id,expected_component_revision:Number(component.revision),successor_id:successor,position_key:'top closer',manufacturer:'Synthetic',model_number:'Replacement',serial_number:'',installation:{target:{type:'component',id:successor},date:{certainty:'unknown',precision:'unknown',year:null,month:null,day:null},source_type:'unknown',source_reference:'',note:'Synthetic concurrency test',correction_of:null,correction_reason:''}}};
 const send=(b:any)=>request(app).post('/api/lifecycle/replacements').set(f.auth).send(b);
 const results=await overlap('openings',f.opening.id,()=>[send(body).then(r=>r),send(body).then(r=>r)]);expect(results.map(r=>r.status).sort()).toEqual([200,201]);expect(results[0].body).toEqual(results[1].body);
 expect((await pool.query('SELECT count(*) FROM sync_operation_receipts WHERE operation_id=$1',[body.operation_id])).rows[0].count).toBe('1');
 expect((await pool.query('SELECT count(*) FROM installation_facts WHERE hardware_component_id=$1',[successor])).rows[0].count).toBe('1');
 const other=randomUUID(),conflicting={...body,operation_id:randomUUID(),entity_id:randomUUID(),payload:{...body.payload,successor_id:other,installation:{...body.payload.installation,target:{type:'component',id:other}}}};
 expect((await send(conflicting)).status).toBe(409);
 const rows=await pool.query('SELECT lifecycle_state,door_leaf_id FROM hardware_components WHERE position_id=(SELECT position_id FROM hardware_components WHERE id=$1)',[successor]);
 expect(rows.rows.filter(r=>r.lifecycle_state==='active')).toHaveLength(1);expect(rows.rows.filter(r=>r.lifecycle_state==='retired')).toHaveLength(1);expect(rows.rows.every(r=>r.door_leaf_id===leaf.id)).toBe(true);
 const before=(await request(app).get('/api/lifecycle/'+f.opening.id).set(f.auth)).body;
 const next=()=>{const id=randomUUID();return {...body,operation_id:randomUUID(),entity_id:randomUUID(),expected_revision:before.revision,payload:{...body.payload,predecessor_id:successor,expected_component_revision:1,successor_id:id,installation:{...body.payload.installation,target:{type:'component',id}}}};};
 const competing=await overlap('openings',f.opening.id,()=>[send(next()).then(r=>r),send(next()).then(r=>r)]);expect(competing.map(r=>r.status).sort()).toEqual([201,409]);
 const after=(await request(app).get('/api/lifecycle/'+f.opening.id).set(f.auth)).body;expect(Number(after.revision)).toBe(Number(before.revision)+1);
 const counts=await pool.query("SELECT (SELECT count(*) FROM component_replacements WHERE predecessor_id=$1) AS replacements,(SELECT count(*) FROM hardware_components WHERE position_id=(SELECT position_id FROM hardware_components WHERE id=$1) AND lifecycle_state='active') AS active",[successor]);expect(counts.rows[0]).toEqual({replacements:'1',active:'1'});
});
