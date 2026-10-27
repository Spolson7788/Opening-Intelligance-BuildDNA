import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ db: null as any, failAudit: false, failConnect: false }));
// In-process disposable SQL only; no connection string, socket or hosted DB.
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => { if(state.failConnect){state.failConnect=false;throw Error('synthetic private connection detail');}return ({ query: (s: string, a?: unknown[]) => {
    if (state.failAudit && /INSERT INTO sync_audit_events/.test(s)) {
      state.failAudit = false;
      throw new Error('Synthetic audit failure after observation, revision, and receipt writes');
    }
    return state.db.query(s, a);
  }, release: () => {} });},
} }));
import { conditionHistoryRouter } from '../src/routes/conditionHistory';
import { conditionObservationSchema } from '../src/services/conditionObservations';
const app = express(); app.use(express.json()); app.use('/api/condition-history', conditionHistoryRouter);
const migration = '20261026190000_condition_observations.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const unknown = { certainty: 'unknown', precision: 'unknown', year: null, month: null, day: null };
let rollbackProven = false;
beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < migration).sort()) {
    await state.db.exec(readFileSync('migrations/' + name, 'utf8')
      .replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()'));
  }
  const script = readFileSync('migrations/' + migration, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;');
  rollbackProven = (await sql("SELECT to_regclass('public.condition_observations') AS name")).rows[0].name === null;
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
});
afterAll(async () => { await state.db?.close(); });
async function user(org = randomUUID(), role = 'admin') {
  const id = randomUUID();
  await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic condition test','customer') ON CONFLICT DO NOTHING", [org]);
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user',$4,'not-a-real-password')", [id,org,id+'@example.invalid',role]);
  return { id, org, token: jwt.sign({ userId: id, organizationId: org, role, sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function fixture() {
  const a = await user(), portfolio = randomUUID(), property = randomUUID(), building = randomUUID(), opening = randomUUID(), frame = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio,a.org]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic property')", [property,portfolio]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')", [building,property]);
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,opening_configuration,install_date) VALUES($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'door','pair','2010-01-01')", [opening,building]);
  await sql("INSERT INTO opening_frames(id,opening_id,condition) VALUES($1,$2,'good')", [frame,opening]);
  const parts = [];
  for (const role of ['active','inactive']) {
    const leaf = randomUUID(), component = randomUUID();
    await sql("INSERT INTO door_leaves(id,opening_id,leaf_role,condition) VALUES($1,$2,$3,'good')", [leaf,opening,role]);
    await sql("INSERT INTO hardware_components(id,opening_id,component_type,tracker_id,mounting_scope,door_leaf_id,condition) VALUES($1::uuid,$2,'closer',($1::uuid)::text,'door_leaf',$3,'good')", [component,opening,leaf]);
    parts.push({ leaf, component, role });
  }
  const context = (u = a) => request(app).get('/api/condition-history/' + opening).set('Authorization','Bearer ' + u.token);
  const command = async (payload: any = {}) => ({ operation_id: randomUUID(), entity_id: randomUUID(), opening_id: opening,
    device_id: randomUUID(), schema_version: 3, app_version: 'condition-history-local-test', protocol_version: 1,
    expected_revision: Number((await sql('SELECT revision FROM openings WHERE id=$1',[opening])).rows[0].revision),
    payload: { target: { type: 'component', id: parts[1].component }, condition: 'worn', observed_date: unknown,
      source_reference: 'Synthetic inspection note', note: '', correction_of: null, correction_reason: '', ...payload } });
  const submit = (b: any, u = a) => request(app).post('/api/condition-history/observations').set('Authorization','Bearer '+u.token).send(b);
  return { a, property, opening, frame, parts, context, command, submit };
}
it('exports one authorized facility snapshot with original correction chains, retired identities and unknown dates', async () => {
  const f=await fixture(), other=await fixture();
  const first=await f.command();expect((await f.submit(first)).status).toBe(201);
  const correction=await f.command({condition:'good',correction_of:first.entity_id,correction_reason:'Synthetic correction'});
  expect((await f.submit(correction)).status).toBe(201);
  await sql("UPDATE hardware_components SET lifecycle_state='retired' WHERE id=$1",[f.parts[1].component]);
  const response=await request(app).get('/api/condition-history/facility/'+f.opening).set('Authorization','Bearer '+f.a.token);
  expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');const r=response.body;
  expect(r.property_id).toBe(f.property);expect(r.openings.map((o:any)=>o.id)).toEqual([f.opening]);
  expect(JSON.stringify(r)).not.toContain(other.opening);expect(r.hardware_components).toHaveLength(2);
  expect(r.hardware_components.find((h:any)=>h.id===f.parts[1].component).lifecycle_state).toBe('retired');
  expect(r.condition_observations).toHaveLength(2);
  expect(r.condition_observations.find((o:any)=>o.id===first.entity_id)).toMatchObject({opening_id:f.opening,is_current:false,observed_date:unknown});
  expect(r.condition_observations.find((o:any)=>o.id===correction.entity_id)).toMatchObject({correction_of:first.entity_id,is_current:true,target_snapshot:{leaf_role:'inactive'}});
  expect(r.openings[0]).toMatchObject({install_date:'2010-01-01',legacy_installation_review_state:'unreviewed'});
  expect(r.service_events).toEqual([]);expect(r.as_of).toBeTruthy();
  expect((await request(app).get('/api/condition-history/facility/'+f.opening).set('Authorization','Bearer '+other.a.token)).status).toBe(404);
  expect((await request(app).get('/api/condition-history/facility/not-a-uuid').set('Authorization','Bearer '+f.a.token)).status).toBe(400);
});
it('facility snapshot includes other openings in the same facility without multiplying shared event evidence',async()=>{
  const f=await fixture();const building=(await sql('SELECT building_id FROM openings WHERE id=$1',[f.opening])).rows[0].building_id;
  const id=randomUUID();await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1::uuid,$2,'SECOND','second-'||($1::uuid)::text,'door')",[id,building]);
  const job=randomUUID();await sql("INSERT INTO service_events(id,opening_id,event_date,work_performed,cost) VALUES($1,$2,'2026-10-01','Synthetic shared job',null)",[job,f.opening]);
  const r=await request(app).get('/api/condition-history/facility/'+f.opening).set('Authorization','Bearer '+f.a.token);
  expect(r.status).toBe(200);expect(r.body.openings.map((o:any)=>o.id).sort()).toEqual([id,f.opening].sort());
  for(const key of ['hardware_components','condition_observations','service_events','positions','replacements'])expect(new Set(r.body[key].map((v:any)=>v.id)).size).toBe(r.body[key].length);
  expect(r.body.openings.find((o:any)=>o.id===id).install_date).toBeNull();
  expect(r.body.service_events).toHaveLength(1);expect(r.body.service_events[0]).toMatchObject({id:job,opening_id:f.opening,cost:null});
});
it('returns a sanitized facility error when connection acquisition fails',async()=>{
 const f=await fixture();state.failConnect=true;
 const r=await request(app).get('/api/condition-history/facility/'+f.opening).set('Authorization','Bearer '+f.a.token);
 expect(r.status).toBe(500);expect(r.body).toEqual({error:'facility_history_unavailable'});
});
it('reauthorizes facility history after provider revocation and rejects invalidated sessions',async()=>{
 const f=await fixture(),provider=await user();
 await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)',[f.property,provider.org,f.a.id]);
 const read=()=>request(app).get('/api/condition-history/facility/'+f.opening).set('Authorization','Bearer '+provider.token);
 expect((await read()).status).toBe(200);await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1',[f.property]);expect((await read()).status).toBe(404);
 await sql('UPDATE users SET session_version=1 WHERE id=$1',[provider.id]);expect((await read()).status).toBe(401);
});
it('migrates transactionally with RLS/default denial and no new API grants or policies', async () => {
  expect(rollbackProven).toBe(true);
  expect((await sql("SELECT relrowsecurity FROM pg_class WHERE oid='condition_observations'::regclass")).rows[0].relrowsecurity).toBe(true);
  expect((await sql("SELECT * FROM pg_policies WHERE tablename='condition_observations'")).rows).toHaveLength(0);
  expect((await sql("SELECT has_table_privilege('oi_pr2_api','condition_observations','SELECT') AS s,has_table_privilege('oi_pr2_api','condition_observations','INSERT') AS i")).rows[0]).toEqual({ s: false, i: false });
});
it('keeps historical observations distinct from current condition, dates, and paired-leaf identity', async () => {
  const f = await fixture();
  expect((await f.context()).body.observations).toEqual([]); // Never backfill legacy/current fields.
  const b = await f.command({ observed_date: { certainty: 'estimated', precision: 'month', year: 2018, month: 6, day: null } });
  const r = await f.submit(b); expect(r.status).toBe(201);
  const c = (await f.context()).body;
  expect(c.targets).toHaveLength(5);
  expect(c.observations[0]).toMatchObject({ target: b.payload.target, condition: 'worn', observed_date: b.payload.observed_date,
    recorded_by_user_id: f.a.id, recording_organization_id: f.a.org, is_current: true,
    target_snapshot: { door_leaf_id: f.parts[1].leaf, leaf_role: 'inactive', tracker_id: f.parts[1].component } });
  expect(c.observations[0].recorded_at).toBeTruthy();
  expect((await sql('SELECT condition FROM hardware_components WHERE id=$1',[f.parts[1].component])).rows[0].condition).toBe('good');
  expect((await sql('SELECT install_date::text FROM openings WHERE id=$1',[f.opening])).rows[0].install_date).toBe('2010-01-01');
  const audit = (await sql('SELECT * FROM sync_audit_events WHERE operation_id=$1',[b.operation_id])).rows;
  expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ actor_user_id: f.a.id, organization_id: f.a.org, action: 'condition_observation_recorded' });
});
it('binds exact retries to the original actor and payload without duplicate rows/revisions', async () => {
  const f = await fixture(), b = await f.command(), first = await f.submit(b);
  expect(first.status).toBe(201); expect((await f.submit(b)).body).toEqual(first.body);
  expect((await f.context()).body.revision).toBe(b.expected_revision + 1);
  expect((await f.context()).body.observations).toHaveLength(1);
  expect((await f.submit({ ...b, payload: { ...b.payload, note: 'changed' } })).status).toBe(409);
  expect((await f.submit(b, await user(f.a.org))).status).toBe(409);
  expect((await f.submit({ ...b, entity_id: randomUUID() })).status).toBe(409);
});
it('reauthorizes both reads and receipt replay after provider revocation and role/session changes', async () => {
  const f = await fixture(), provider = await user(), b = await f.command();
  await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)',[f.property,provider.org,f.a.id]);
  expect((await f.submit(b,provider)).status).toBe(201);
  await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1',[f.property]);
  expect((await f.context(provider)).status).toBe(404); expect((await f.submit(b,provider)).status).toBe(404);
  const b2 = await f.command(); expect((await f.submit(b2)).status).toBe(201);
  await sql("UPDATE users SET role='viewer' WHERE id=$1",[f.a.id]); expect((await f.submit(b2)).status).toBe(403);
  await sql('UPDATE users SET session_version=1 WHERE id=$1',[f.a.id]); expect((await f.context()).status).toBe(401);
});
it('denies other tenants, invalid targets, stale revisions and non-admin/manager writes', async () => {
  const f = await fixture(), other = await fixture(), b = await f.command();
  expect((await f.context(other.a)).status).toBe(404); expect((await f.submit(b,other.a)).status).toBe(404);
  expect((await f.submit({ ...b, expected_revision: 999 })).body.error).toBe('revision_conflict');
  expect((await f.submit({ ...b, payload: { ...b.payload, target: { type: 'component', id: other.parts[0].component } } })).body.error).toBe('target_not_in_opening');
  // Technicians and inspectors may record observations since 2026-10-27 (role matrix in inspectorPermissions.test.ts).
 for (const role of ['viewer']) expect((await f.submit(b,await user(f.a.org,role))).status).toBe(403);
  expect((await f.submit(b,await user(f.a.org,'facilities_manager'))).status).toBe(201);
  expect((await request(app).get('/api/condition-history/'+f.opening)).status).toBe(401);
});
it('appends corrections with immutable target identity, original snapshots and a single successor', async () => {
  const f = await fixture(), b = await f.command(); expect((await f.submit(b)).status).toBe(201);
  await sql('UPDATE hardware_components SET door_leaf_id=$2 WHERE id=$1',[f.parts[1].component,f.parts[0].leaf]);
  const correction = await f.command({ correction_of: b.entity_id, correction_reason: 'Review of original note', condition: 'failed', observed_date: { certainty: 'confirmed', precision: 'day', year: 2020, month: 2, day: 29 } });
  expect((await f.submit({ ...correction, payload: { ...correction.payload, target: { type: 'component', id: f.parts[0].component } } })).body.error).toBe('correction_target_mismatch');
  expect((await f.submit(correction)).status).toBe(201);
  expect((await f.submit(await f.command({ ...correction.payload }))).body.error).toBe('observation_already_corrected');
  const observations = (await f.context()).body.observations;
  expect(observations).toHaveLength(2); expect(observations.find((r:any)=>r.id===b.entity_id)).toMatchObject({ condition: 'worn', is_current: false, observed_date: unknown });
  expect(observations.find((r:any)=>r.id===correction.entity_id)).toMatchObject({ condition: 'failed', is_current: true, target_snapshot: { door_leaf_id: f.parts[1].leaf, leaf_role: 'inactive' } });
  const next = await f.command({ ...correction.payload, correction_of: correction.entity_id, correction_reason: 'Second review' });
  expect((await f.submit(next)).status).toBe(201);
  expect((await f.context()).body.observations.filter((r:any)=>r.is_current)).toHaveLength(1);
});
it('supports frame, leaf and retired-instance history, while retired openings reject new writes', async () => {
  const f = await fixture();
  for (const target of [{ type:'frame',id:f.frame },{type:'door_leaf',id:f.parts[1].leaf}]) expect((await f.submit(await f.command({ target }))).status).toBe(201);
  await sql("UPDATE hardware_components SET lifecycle_state='retired' WHERE id=$1",[f.parts[1].component]);
  expect((await f.submit(await f.command())).status).toBe(201);
  expect((await f.context()).body.targets.find((t:any)=>t.target.id===f.parts[1].component).lifecycle_state).toBe('retired');
  await sql("UPDATE openings SET status='decommissioned' WHERE id=$1",[f.opening]);
  expect((await f.submit(await f.command())).body.error).toBe('opening_retired');
  expect((await f.context()).body.observations).toHaveLength(3);
});
it('validates certainty, calendar dates, correction reasons, bounds and strict server-owned fields', async () => {
  const f = await fixture(), b = await f.command();
  const invalid = [ { source_reference:'' }, { source_reference:'x'.repeat(2001) }, { note:'x'.repeat(4001) },
    { condition:'excellent' }, { correction_of:randomUUID(),correction_reason:'' }, { correction_reason:'orphan reason' },
    { observed_date:{certainty:'confirmed',precision:'day',year:2023,month:2,day:29} },
    { observed_date:{...unknown,year:2020} }, { observed_date:{certainty:'estimated',precision:'month',year:2020,month:1,day:1} },
    { recorded_by_user_id:randomUUID() } ];
  for (const changes of invalid) expect((await f.submit({ ...b, payload:{...b.payload,...changes} })).status).toBe(422);
  expect(conditionObservationSchema.safeParse({...b.payload,observed_date:{certainty:'estimated',precision:'year',year:2020,month:null,day:null}}).success).toBe(true);
  expect((await f.context()).body.observations).toHaveLength(0);
});
it('enforces append-only/FK protection and rolls back receipt conflicts atomically', async () => {
  const f = await fixture(), b = await f.command(); expect((await f.submit(b)).status).toBe(201);
  await expect(sql("UPDATE condition_observations SET note='erase' WHERE id=$1",[b.entity_id])).rejects.toThrow('append-only');
  await expect(sql('DELETE FROM condition_observations WHERE id=$1',[b.entity_id])).rejects.toThrow('append-only');
  await expect(sql('DELETE FROM hardware_components WHERE id=$1',[f.parts[1].component])).rejects.toThrow();
  const revision = (await f.context()).body.revision;
  const duplicate = { ...await f.command(), entity_id:b.entity_id };
  expect((await f.submit(duplicate)).status).toBe(409);
  expect((await f.context()).body.revision).toBe(revision);
  expect((await sql('SELECT * FROM sync_operation_receipts WHERE operation_id=$1',[duplicate.operation_id])).rows).toHaveLength(0);
  // Direct malformed correction cannot bypass the exact target composite FK.
  const row = (await sql('SELECT * FROM condition_observations WHERE id=$1',[b.entity_id])).rows[0];
  await expect(sql(`INSERT INTO condition_observations SELECT $1,opening_id,target_type,$2,NULL,NULL,$2,condition,
    certainty,precision,year,month,day,source_reference,note,target_snapshot,recorded_at,recorded_by_user_id,recording_organization_id,id,'wrong target'
    FROM condition_observations WHERE id=$3`,[randomUUID(),f.parts[0].component,row.id])).rejects.toThrow();
});
it('rolls back observation, revision and receipt when the final audit insert fails', async () => {
  const f = await fixture(), b = await f.command();
  state.failAudit = true;
  expect((await f.submit(b)).status).toBe(500);
  const c = (await f.context()).body;
  expect(c.revision).toBe(b.expected_revision); expect(c.observations).toHaveLength(0);
  expect((await sql('SELECT * FROM sync_operation_receipts WHERE operation_id=$1',[b.operation_id])).rows).toHaveLength(0);
  expect((await sql('SELECT * FROM sync_audit_events WHERE operation_id=$1',[b.operation_id])).rows).toHaveLength(0);
  expect((await f.submit(b)).status).toBe(201);
});

it('technicians and inspectors record observations in their own facility only; viewers cannot', async () => {
 const f=await fixture(), other=await fixture();
 for (const role of ['technician','inspector']) { const u=await user(f.a.org,role); expect((await f.submit(await f.command(),u)).status).toBe(201); }
 expect((await f.submit(await f.command(),await user(f.a.org,'viewer'))).status).toBe(403);
 expect((await f.submit(await f.command(),await user(other.a.org,'technician'))).status).toBe(404);
});
