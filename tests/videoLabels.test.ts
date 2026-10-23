import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/pool';
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from './helpers';
async function fixture(complete=true) {
  const org=await signupTestOrg(),scope=await createPortfolioHierarchy(org.token);
  const opening=await createTestOpening(org.token,scope.buildingId,{opening_configuration:'pair'});
  const auth={Authorization:`Bearer ${org.token}`};
  if(complete){
    await request(app).put(`/api/openings/${opening.id}/frame`).set(auth).send({condition:'good'});
    for(const leaf_role of ['active','inactive'])await request(app).post(`/api/openings/${opening.id}/door-leaves`).set(auth).send({leaf_role,condition:'good'});
    await request(app).post('/api/hardware').set(auth).send({opening_id:opening.id,component_type:'closer',condition:'good',review_state:'reviewed'});
    expect((await request(app).post(`/api/openings/${opening.id}/complete`).set(auth)).status).toBe(200);
  }
  return {org,scope,opening,auth};
}
describe('canonical labels',()=>{
  it('keeps Field and Dashboard payloads stable through rename, replay, and reprint',async()=>{
    const f=await fixture();
    expect((await request(app).get('/api/labels/config').set(f.auth)).body.field_base).toBe('https://staging.example.test/field/');
    const old=await request(app).get(`/api/openings/${f.opening.id}/qr-code`).set(f.auth);expect(old.status).toBe(200);
    const preview=()=>request(app).get(`/api/labels/preview?opening_ids=${f.opening.id}`).set(f.auth);
    expect((await preview()).body.items[0].payload).toBe(old.body.payload);
    expect((await pool.query("SELECT count(*) FROM sync_audit_events WHERE action='label_print_file_generated' AND opening_id=$1",[f.opening.id])).rows[0].count).toBe('0');
    const command={operation_id:randomUUID(),opening_ids:[f.opening.id],template:'single-2in-v1'};
    const generated=await request(app).post('/api/labels/generations').set(f.auth).send(command);expect(generated.status).toBe(201);
    expect(generated.body.status).toBe('print_file_generated');
    expect((await request(app).post('/api/labels/generations').set(f.auth).send(command)).body).toEqual(generated.body);
    expect((await request(app).post('/api/labels/generations').set(f.auth).send({...command,template:'letter-2in-v1'})).status).toBe(409);
    await pool.query("UPDATE openings SET opening_code=$2 WHERE id=$1",[f.opening.id,'RENAMED-'+randomUUID()]);
    const renamed=(await preview()).body.items[0];expect(renamed.payload).toBe(old.body.payload);expect(renamed.opening_code).not.toBe(old.body.opening_code);
    const token=new URL(renamed.payload).pathname.split('/').at(-1);
    expect((await request(app).get(`/api/openings/by-qr/${token}`).set(f.auth)).body.id).toBe(f.opening.id);
    expect((await pool.query("SELECT count(*) FROM sync_audit_events WHERE action='label_print_file_generated' AND opening_id=$1",[f.opening.id])).rows[0].count).toBe('1');
    await pool.query("UPDATE openings SET status='decommissioned' WHERE id=$1",[f.opening.id]);
    expect((await preview()).body.items[0].missing).toContain('opening_retired');
    expect((await request(app).post('/api/labels/generations').set(f.auth).send(command)).status).toBe(409);
  });
  it('applies readiness to single, batch, preview and generation without leaking inaccessible labels',async()=>{
    const f=await fixture(false);
    const preview=await request(app).get(`/api/labels/preview?opening_ids=${f.opening.id}`).set(f.auth);
    expect(preview.body.items[0]).toMatchObject({eligible:false,payload:null,qr_data_url:null});
    expect(preview.body.items[0].missing).toContain('opening_not_complete');
    expect((await request(app).get(`/api/openings/${f.opening.id}/qr-code`).set(f.auth)).status).toBe(409);
    const batch=await request(app).get(`/api/openings/qr-codes?building_id=${f.scope.buildingId}`).set(f.auth);
    expect(batch.body.items).toEqual([]);expect(batch.body.blocked[0].id).toBe(f.opening.id);
    expect((await request(app).post('/api/labels/generations').set(f.auth).send({operation_id:randomUUID(),opening_ids:[f.opening.id],template:'letter-2in-v1'})).status).toBe(409);
    const other=await signupTestOrg();
    const denied=await request(app).get(`/api/labels/preview?opening_ids=${f.opening.id}`).set('Authorization',`Bearer ${other.token}`);
    expect(denied.status).toBe(404);expect(denied.body).toEqual({error:'not_found'});
    expect((await request(app).get(`/api/labels/preview?opening_ids=${f.opening.id}`)).status).toBe(401);
  });
});
