import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const state = vi.hoisted(() => ({ appPool: null as any, watchOpening: null as string | null,
  watchPropertyOpening: null as string | null, waitingPids: new Set<number>(), roles: new Set<string>() }));
vi.mock('../src/db/pool', () => {
  async function connect() {
    const client = await state.appPool.connect();
    try {
      await client.query('SET ROLE oi_pr2_api');
      const identity = (await client.query('SELECT current_user AS role')).rows[0].role;
      if (identity !== 'oi_pr2_api') throw new Error('Local restricted role was not established');
      state.roles.add(identity);
    } catch (error) { client.release(true); throw error; }
    return {
      query: (text: string, args?: unknown[]) => {
        if (text === 'SELECT id FROM openings WHERE id=$1 FOR UPDATE' && args?.[0] === state.watchOpening) {
          state.waitingPids.add(client.processID);
        }
        if (text.includes('FOR SHARE OF p') && args?.[0] === state.watchPropertyOpening) {
          state.waitingPids.add(client.processID);
        }
        return client.query(text, args);
      },
      release: () => { void client.query('RESET ROLE').then(() => client.release(), () => client.release(true)); },
    };
  }
  return { pool: { connect, query: async (text: string, args?: unknown[]) => {
    const c = await connect(); try { return await c.query(text, args); } finally { c.release(); }
  } } };
});
import { conditionHistoryRouter } from '../src/routes/conditionHistory';

// This harness cannot select a hosted endpoint through environment variables.
// Root prepares this dedicated synthetic instance/schema; no startup or migrations here.
const options = { host: '127.0.0.1', port: 55439, database: 'condition_readiness', user: 'postgres',
  password: () => '', ssl: false as const, connectionTimeoutMillis: 2000, options: '-c statement_timeout=8000',
  application_name: 'oi-condition-realpg-tests' };
const admin = new Pool({ ...options, max: 4 });
const app = express(); app.use(express.json()); app.use('/api/condition-history', conditionHistoryRouter);
const sql = (text: string, args?: any[]) => admin.query(text, args);
const unknown = { certainty: 'unknown', precision: 'unknown', year: null, month: null, day: null };

beforeAll(async () => {
  const identity = (await sql('SELECT current_database() AS db,inet_server_addr()::text AS address,inet_server_port() AS port,current_user AS role')).rows[0];
  expect({ ...identity, address: identity.address.replace(/\/32$/, '') }).toEqual({ db: 'condition_readiness', address: '127.0.0.1', port: 55439, role: 'postgres' });
  expect((await sql("SELECT to_regclass('public.condition_observations')::text AS name")).rows[0].name).toBe('condition_observations');
  state.appPool = new Pool({ ...options, max: 8 });
});
afterAll(async () => { await state.appPool?.end(); await admin.end(); });

async function user(org = randomUUID(), role = 'admin') {
  const id = randomUUID();
  await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic concurrent condition test','customer') ON CONFLICT DO NOTHING", [org]);
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic local user',$4,'not-a-real-password')", [id,org,id+'@example.invalid',role]);
  return { id, org, token: jwt.sign({ userId:id,organizationId:org,role,sessionVersion:0 },process.env.JWT_SECRET!) };
}
async function fixture() {
  const a = await user(), portfolio = randomUUID(), property = randomUUID(), building = randomUUID(), opening = randomUUID(), frame = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic concurrency portfolio')",[portfolio,a.org]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic property')",[property,portfolio]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')",[building,property]);
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,opening_configuration) VALUES($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'door','pair')",[opening,building]);
  await sql("INSERT INTO opening_frames(id,opening_id,condition) VALUES($1,$2,'good')",[frame,opening]);
  const parts = [];
  for (const role of ['active','inactive']) {
    const leaf = randomUUID(), component = randomUUID();
    await sql("INSERT INTO door_leaves(id,opening_id,leaf_role,condition) VALUES($1,$2,$3,'good')",[leaf,opening,role]);
    await sql("INSERT INTO hardware_components(id,opening_id,component_type,tracker_id,mounting_scope,door_leaf_id,condition) VALUES($1::uuid,$2,'closer',($1::uuid)::text,'door_leaf',$3,'good')",[component,opening,leaf]);
    parts.push({ leaf,component,role });
  }
  const context = (u = a) => request(app).get('/api/condition-history/'+opening).set('Authorization','Bearer '+u.token);
  const command = async (payload: any = {}) => ({ operation_id:randomUUID(),entity_id:randomUUID(),opening_id:opening,
    device_id:randomUUID(),schema_version:3,app_version:'synthetic-realpg-test',protocol_version:1,
    expected_revision:Number((await sql('SELECT revision FROM openings WHERE id=$1',[opening])).rows[0].revision),
    payload:{ target:{type:'component',id:parts[1].component},condition:'worn',observed_date:unknown,
      source_reference:'Synthetic inspection note',note:'',correction_of:null,correction_reason:'',...payload } });
  const submit = (b:any,u=a) => request(app).post('/api/condition-history/observations').set('Authorization','Bearer '+u.token).send(b);
  return { a,property,opening,frame,parts,context,command,submit };
}

// Hold the opening row until two independent API sessions are demonstrably waiting
// for its lock. This establishes actual overlap, rather than sequential Promise timing.
async function race(f: Awaited<ReturnType<typeof fixture>>, bodies: any[]) {
  const blocker = await admin.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM openings WHERE id=$1 FOR UPDATE',[f.opening]);
  state.watchOpening = f.opening; state.waitingPids.clear();
  const requests = Promise.all(bodies.map(body => f.submit(body).then(response => response)));
  let observed = false;
  try {
    const deadline = Date.now()+5000;
    while (Date.now()<deadline) {
      if (state.waitingPids.size >= 2) {
        const waiters = (await sql("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'",[[...state.waitingPids]])).rows[0].n;
        if (waiters >= 2) { observed = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve,20));
    }
  } finally {
    state.watchOpening = null;
    await blocker.query('ROLLBACK'); blocker.release();
  }
  const responses = await requests;
  expect(observed, 'two restricted API connections must overlap waiting for the opening lock').toBe(true);
  return responses;
}

it('simultaneous identical commands create one observation/receipt/audit and one revision',async()=>{
  const f=await fixture(),b=await f.command();
  const result=await race(f,[b,b]);expect(result.map(r=>r.status).sort()).toEqual([200,201]);expect(result[0].body).toEqual(result[1].body);
  const c=await f.context();expect(c.status).toBe(200);expect(c.body.observations).toHaveLength(1);expect(c.body.revision).toBe(b.expected_revision+1);
  expect((await sql('SELECT count(*)::int AS n FROM sync_operation_receipts WHERE operation_id=$1',[b.operation_id])).rows[0].n).toBe(1);
  expect((await sql('SELECT count(*)::int AS n FROM sync_audit_events WHERE operation_id=$1',[b.operation_id])).rows[0].n).toBe(1);
  expect([...state.roles]).toEqual(['oi_pr2_api']);
});
it('simultaneous changed payload with the same operation ID rejects reuse',async()=>{
  const f=await fixture(),b=await f.command();
  const result=await race(f,[b,{...b,payload:{...b.payload,condition:'failed'}}]);
  expect(result.map(r=>r.status).sort()).toEqual([201,409]);expect(result.find(r=>r.status===409)!.body.error).toBe('idempotency_key_reused');
  expect((await f.context()).body.observations).toHaveLength(1);
});
it('simultaneous distinct operations at the same revision allow one winner',async()=>{
  const f=await fixture(),a=await f.command(),b=await f.command({condition:'failed'});
  const result=await race(f,[a,b]);expect(result.map(r=>r.status).sort()).toEqual([201,409]);expect(result.find(r=>r.status===409)!.body.error).toBe('revision_conflict');
  const c=(await f.context()).body;expect(c.revision).toBe(a.expected_revision+1);expect(c.observations).toHaveLength(1);
});
it('concurrent corrections cannot fork, even if the loser later uses the fresh revision',async()=>{
  const f=await fixture(),first=await f.command();expect((await f.submit(first)).status).toBe(201);
  const a=await f.command({correction_of:first.entity_id,correction_reason:'Synthetic review A',condition:'failed'});
  const b=await f.command({correction_of:first.entity_id,correction_reason:'Synthetic review B',condition:'good'});
  const result=await race(f,[a,b]);expect(result.map(r=>r.status).sort()).toEqual([201,409]);
  const loser=result[0].status===409?a:b;
  const current=(await f.context()).body;
  expect((await f.submit({...loser,expected_revision:current.revision})).body.error).toBe('observation_already_corrected');
  expect(current.observations).toHaveLength(2);expect(current.observations.filter((r:any)=>r.is_current)).toHaveLength(1);
  expect(current.observations.find((r:any)=>r.id===first.entity_id)).toMatchObject({condition:'worn',is_current:false});
});
it('rejects foreign opening targets, other tenants, stale revisions and another actor replaying',async()=>{
  const f=await fixture(),other=await fixture(),b=await f.command();
  expect((await f.context(other.a)).status).toBe(404);expect((await f.submit(b,other.a)).status).toBe(404);
  expect((await f.submit({...b,expected_revision:999})).body.error).toBe('revision_conflict');
  expect((await f.submit({...b,payload:{...b.payload,target:{type:'component',id:other.parts[0].component}}})).body.error).toBe('target_not_in_opening');
  expect((await f.submit(b)).status).toBe(201);
  expect((await f.submit(b,await user(f.a.org))).body.error).toBe('idempotency_key_reused');
});
it('reauthorizes provider receipt replay after assignment revocation',async()=>{
  const f=await fixture(),provider=await user(),b=await f.command();
  await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)',[f.property,provider.org,f.a.id]);
  expect((await f.submit(b,provider)).status).toBe(201);
  await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1',[f.property]);
  expect((await f.submit(b,provider)).status).toBe(404);expect((await f.context(provider)).status).toBe(404);
});
it('a request waiting behind provider revocation rechecks access and creates no observation',async()=>{
  const f=await fixture(),provider=await user(),b=await f.command();
  await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)',[f.property,provider.org,f.a.id]);
  const blocker=await admin.connect();await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM properties WHERE id=$1 FOR UPDATE',[f.property]);
  state.watchPropertyOpening=f.opening;state.waitingPids.clear();
  const pending=f.submit(b,provider).then(r=>r);let waiting=false;
  try {
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      if(state.waitingPids.size){
        const n=(await sql("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'",[[...state.waitingPids]])).rows[0].n;
        if(n===1){waiting=true;break;}
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await blocker.query('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2',[f.property,provider.org]);
    await blocker.query('COMMIT');
  }finally{state.watchPropertyOpening=null;await blocker.query('ROLLBACK');blocker.release();}
  const result=await pending;
  expect(waiting,'provider request must wait on the property row before revocation commits').toBe(true);
  expect(result.status).toBe(404);expect(result.body.error).toBe('not_found');
  const c=(await f.context()).body;expect(c.observations).toHaveLength(0);expect(c.revision).toBe(b.expected_revision);
  expect((await sql('SELECT count(*)::int AS n FROM sync_operation_receipts WHERE operation_id=$1',[b.operation_id])).rows[0].n).toBe(0);
});
it('a real database audit failure rolls back observation, revision and receipt together',async()=>{
  const f=await fixture(),b=await f.command();
  const name='condition_test_audit_'+randomUUID().replace(/-/g,'');let functionCreated=false,triggerCreated=false;
  try{
    // Disposable local fault injection, restricted to this one synthetic operation.
    await sql(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.operation_id='${b.operation_id}'::uuid THEN RAISE EXCEPTION 'synthetic condition audit failure'; END IF;
      RETURN NEW; END $$`);functionCreated=true;
    await sql(`CREATE TRIGGER ${name} BEFORE INSERT ON sync_audit_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);triggerCreated=true;
    expect((await f.submit(b)).status).toBe(500);
    const c=(await f.context()).body;expect(c.observations).toHaveLength(0);expect(c.revision).toBe(b.expected_revision);
    expect((await sql('SELECT count(*)::int AS n FROM sync_operation_receipts WHERE operation_id=$1',[b.operation_id])).rows[0].n).toBe(0);
    expect((await sql('SELECT count(*)::int AS n FROM sync_audit_events WHERE operation_id=$1',[b.operation_id])).rows[0].n).toBe(0);
  }finally{
    if(triggerCreated)await sql(`DROP TRIGGER ${name} ON sync_audit_events`);
    if(functionCreated)await sql(`DROP FUNCTION ${name}()`);
  }
  expect((await f.submit(b)).status).toBe(201);
});
it('enforces live roles and session revocation without changing conditions or paired identity',async()=>{
  const f=await fixture(),b=await f.command();
  for(const role of ['technician','inspector','viewer'])expect((await f.submit(b,await user(f.a.org,role))).status).toBe(403);
  const manager=await user(f.a.org,'facilities_manager');expect((await f.submit(b,manager)).status).toBe(201);
  await sql("UPDATE users SET role='viewer' WHERE id=$1",[manager.id]);expect((await f.submit(b,manager)).status).toBe(403);
  await sql('UPDATE users SET session_version=1 WHERE id=$1',[f.a.id]);expect((await f.context()).status).toBe(401);
  const rows=(await sql('SELECT id,condition,door_leaf_id FROM hardware_components WHERE opening_id=$1 ORDER BY id',[f.opening])).rows;
  expect(rows).toHaveLength(2);for(const part of f.parts)expect(rows.find(r=>r.id===part.component)).toMatchObject({condition:'good',door_leaf_id:part.leaf});
  expect((await sql('SELECT condition FROM opening_frames WHERE id=$1',[f.frame])).rows[0].condition).toBe('good');
  expect((await sql('SELECT condition FROM door_leaves WHERE opening_id=$1',[f.opening])).rows.every(r=>r.condition==='good')).toBe(true);
});
