import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ db: null as any }));
// M3B: schedule type correction + archive. In-process disposable SQL only; synthetic data.
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/storage', () => ({ getPresignedUploadUrl: async (key: string) => 'https://storage.invalid/' + key }));
import { facilitySchedulesRouter } from '../src/routes/facilitySchedules';
import { scheduleImportsRouter } from '../src/routes/scheduleImports';
import { kindForFilename, kindMismatch } from '../src/services/scheduleKind';
const app = express(); app.use(express.json());
app.use('/api/facility-schedules', facilitySchedulesRouter); app.use('/api/schedule-imports', scheduleImportsRouter);
const migration = '20261028120000_schedule_kind_corrections.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
let rollbackProven = false, undoProven = false;
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < migration).sort()) await state.db.exec(fix(readFileSync('migrations/' + name, 'utf8')));
  await state.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT PRIMARY KEY)');
  const script = readFileSync('migrations/' + migration, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;');
  rollbackProven = (await sql("SELECT to_regclass('public.facility_schedule_events') AS n")).rows[0].n === null;
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  await state.db.exec(readFileSync('docs/rollback/20261028120000_schedule_kind_corrections_rollback.sql', 'utf8'));
  const cols = (await sql("SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name='facility_schedules' AND column_name LIKE 'archived%'")).rows[0].c;
  undoProven = cols === 0 && (await sql("SELECT to_regclass('public.facility_schedule_events') AS n")).rows[0].n === null;
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
}, 120000);
afterAll(async () => { await state.db?.close(); });

async function org() { const id = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic org','customer')", [id]); return id; }
async function user(orgId: string, role = 'admin') {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user',$4,'not-a-real-password')", [id, orgId, id + '@example.invalid', role]);
  return { id, org: orgId, token: jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function facility() {
  const owner = await org(), admin = await user(owner), portfolio = randomUUID(), property = randomUUID(), building = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio, owner]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [property, portfolio]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')", [building, property]);
  return { owner, admin, property, building };
}
async function schedule(f: any, kind: string, filename: string) {
  const id = randomUUID(), v = randomUUID();
  await sql("INSERT INTO facility_schedules(id,property_id,created_by_organization_id,created_by_user_id,kind,title,head_version) VALUES($1,$2,$3,$4,$5,'Synthetic schedule',1)", [id, f.property, f.owner, f.admin.id, kind]);
  const ct = filename.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  await sql(`INSERT INTO facility_schedule_versions(id,schedule_id,version,storage_key,original_filename,content_type,byte_size,sha256,uploaded_by_user_id,uploaded_by_organization_id)
    VALUES($1,$2,1,$3,$4,$5,10,$6,$7,$8)`, [v, id, 'facility-schedules/' + f.property + '/' + v + '.x', filename, ct, 'b'.repeat(64), f.admin.id, f.owner]);
  return { id, v };
}
async function draftImport(f: any, doorVersion: string) {
  const id = randomUUID();
  await sql("INSERT INTO schedule_imports(id,property_id,building_id,door_version_id,created_by_user_id,created_by_organization_id,created_at) VALUES($1,$2,$3,$4,$5,$6,now()-interval '1 hour')",
    [id, f.property, f.building, doorVersion, f.admin.id, f.owner]);
  return id;
}
const post = (u: any, path: string, body: any = {}) => request(app).post(path).set('Authorization', 'Bearer ' + u.token).send(body);
const get = (u: any, path: string) => request(app).get(path).set('Authorization', 'Bearer ' + u.token);
const tick = () => new Promise(r => setTimeout(r, 30));

describe('M3B schedule type correction and archive', () => {
  it('migration is additive, rolls back in a transaction, and the undo script removes it', () => {
    expect(rollbackProven).toBe(true); expect(undoProven).toBe(true);
  });
  it('mismatch helper follows the upload picker rule', () => {
    expect(kindForFilename('a.docx')).toBe('hardware'); expect(kindForFilename('a.xlsx')).toBe('door'); expect(kindForFilename('a.pdf')).toBe(null);
    expect(kindMismatch('door', 'x.docx')).toBe(true); expect(kindMismatch('hardware', 'x.docx')).toBe(false); expect(kindMismatch('door', 'x.pdf')).toBe(false);
  });
  it('fitting kind change succeeds with an event row and audit_log entry', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'hw.docx');
    const r = await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware', reason: 'Uploaded with wrong type' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ kind: 'hardware', previous_kind: 'door', mismatch_acknowledged: false, stale_draft_import_ids: [] });
    expect((await sql('SELECT kind FROM facility_schedules WHERE id=$1', [s.id])).rows[0].kind).toBe('hardware');
    const ev = (await sql('SELECT event,from_kind,to_kind,reason,actor_user_id FROM facility_schedule_events WHERE schedule_id=$1', [s.id])).rows;
    expect(ev).toEqual([{ event: 'kind_changed', from_kind: 'door', to_kind: 'hardware', reason: 'Uploaded with wrong type', actor_user_id: f.admin.id }]);
    await tick();
    const al = (await sql("SELECT action FROM audit_log WHERE path=$1", [`/api/facility-schedules/${s.id}/kind`])).rows;
    expect(al.map((a: any) => a.action)).toEqual(['Changed schedule type']);
  });
  it('mismatching kind needs acknowledge_mismatch (warning, not a block)', async () => {
    const f = await facility(); const s = await schedule(f, 'hardware', 'hw.docx');
    const w = await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'door', reason: 'test' });
    expect(w.status).toBe(409); expect(w.body.error).toBe('kind_file_mismatch_unacknowledged'); expect(w.body.warning).toContain('hw.docx');
    expect((await sql('SELECT count(*)::int c FROM facility_schedule_events WHERE schedule_id=$1', [s.id])).rows[0].c).toBe(0);
    const ok = await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'door', reason: 'test', acknowledge_mismatch: true });
    expect(ok.status).toBe(200); expect(ok.body.mismatch_acknowledged).toBe(true);
  });
  it('rejects missing reason, unchanged kind and unknown body fields', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'd.xlsx');
    expect((await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware' })).status).toBe(400);
    expect((await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware', reason: 'x', extra: 1 })).status).toBe(400);
    expect((await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'door', reason: 'x' })).body.error).toBe('kind_unchanged');
  });
  it('blocks a kind change when a confirmed import uses the schedule (API and trigger)', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'd.xlsx'); const imp = await draftImport(f, s.v);
    await sql("UPDATE schedule_imports SET status='confirmed', confirmed_at=now(), confirmed_by_user_id=$2, result='{}'::jsonb WHERE id=$1", [imp, f.admin.id]);
    const r = await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware', reason: 'x', acknowledge_mismatch: true });
    expect(r.status).toBe(409); expect(r.body).toEqual({ error: 'schedule_used_by_confirmed_import', import_ids: [imp] });
    await expect(state.db.exec(`BEGIN; INSERT INTO facility_schedule_events(id,schedule_id,event,from_kind,to_kind,reason,actor_user_id,actor_organization_id)
      VALUES('${randomUUID()}','${s.id}','kind_changed','door','hardware','x','${f.admin.id}','${f.owner}'); UPDATE facility_schedules SET kind='hardware' WHERE id='${s.id}'; COMMIT;`))
      .rejects.toThrow(/confirmed import/);
    await state.db.exec('ROLLBACK').catch(() => {});
    expect((await sql('SELECT kind FROM facility_schedules WHERE id=$1', [s.id])).rows[0].kind).toBe('door');
  });
  it('trigger refuses a kind or archive change without a same-transaction event; events are append-only', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'd.xlsx');
    await expect(sql("UPDATE facility_schedules SET kind='hardware' WHERE id=$1", [s.id])).rejects.toThrow(/kind_changed event/);
    await expect(sql("UPDATE facility_schedules SET archived_at=now(), archived_by_user_id=$2 WHERE id=$1", [s.id, f.admin.id])).rejects.toThrow(/archive event/);
    await expect(sql("UPDATE facility_schedules SET title='other' WHERE id=$1", [s.id])).rejects.toThrow(/immutable/);
    await post(f.admin, `/api/facility-schedules/${s.id}/archive`, {});
    await expect(sql('UPDATE facility_schedule_events SET reason=$2 WHERE schedule_id=$1', [s.id, 'x'])).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM facility_schedule_events WHERE schedule_id=$1', [s.id])).rejects.toThrow(/append-only/);
    expect((await sql('UPDATE facility_schedules SET head_version=1 WHERE id=$1 RETURNING id', [s.id])).rows.length).toBe(1);
  });
  it('draft imports become stale after a kind change and cannot be confirmed until restarted', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'd.xlsx'); const imp = await draftImport(f, s.v);
    const r = await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware', reason: 'x', acknowledge_mismatch: true });
    expect(r.status).toBe(200); expect(r.body.stale_draft_import_ids).toEqual([imp]);
    const list = await get(f.admin, `/api/schedule-imports/by-property/${f.property}`);
    expect(list.body.find((i: any) => i.id === imp).stale).toBe(true);
    const c = await post(f.admin, `/api/schedule-imports/${imp}/confirm`, { resolutions: {} });
    expect(c.status).toBe(409); expect(c.body.error).toBe('import_stale_schedule_type_changed');
    expect((await sql('SELECT status FROM schedule_imports WHERE id=$1', [imp])).rows[0].status).toBe('draft');
    // A fresh draft started after the change (restart) is not stale.
    const fresh = randomUUID();
    await sql("INSERT INTO schedule_imports(id,property_id,building_id,door_version_id,created_by_user_id,created_by_organization_id,created_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 second')",
      [fresh, f.property, f.building, s.v, f.admin.id, f.owner]);
    const list2 = await get(f.admin, `/api/schedule-imports/by-property/${f.property}`);
    expect(list2.body.find((i: any) => i.id === fresh).stale).toBe(false);
  });
  it('archive hides a schedule from lists, keeps versions, is reversible and audited', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'd.xlsx');
    const a = await post(f.admin, `/api/facility-schedules/${s.id}/archive`, { reason: 'Duplicate upload' });
    expect(a.status).toBe(200); expect(a.body.archived_at).toBeTruthy();
    expect((await post(f.admin, `/api/facility-schedules/${s.id}/archive`, {})).body.error).toBe('already_archived');
    expect((await get(f.admin, `/api/facility-schedules/by-property/${f.property}`)).body).toEqual([]);
    const all = (await get(f.admin, `/api/facility-schedules/by-property/${f.property}?include_archived=1`)).body;
    expect(all).toHaveLength(1); expect(all[0].archived_at).toBeTruthy(); expect(all[0].versions).toHaveLength(1);
    expect((await post(f.admin, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware', reason: 'x' })).body.error).toBe('schedule_archived');
    const u = await post(f.admin, `/api/facility-schedules/${s.id}/unarchive`, {});
    expect(u.status).toBe(200); expect(u.body.archived_at).toBe(null);
    expect((await get(f.admin, `/api/facility-schedules/by-property/${f.property}`)).body[0].archived_at).toBe(null);
    const ev = (await get(f.admin, `/api/facility-schedules/${s.id}/events`)).body.map((e: any) => e.event);
    expect(ev).toEqual(['archived', 'unarchived']);
    await tick();
    const al = (await sql("SELECT action FROM audit_log WHERE path LIKE $1 ORDER BY created_at", [`/api/facility-schedules/${s.id}/%`])).rows.map((r: any) => r.action);
    expect(al).toEqual(['Archived schedule', 'Unarchived schedule']);
  });
  it('assigned provider admins may correct and archive; other roles and orgs may not', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'd.xlsx');
    const prov = await org(), provAdmin = await user(prov, 'facilities_manager'), tech = await user(f.owner, 'technician');
    const stranger = await user(await org());
    expect((await post(tech, `/api/facility-schedules/${s.id}/archive`, {})).status).toBe(403);
    expect((await post(tech, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware', reason: 'x' })).status).toBe(403);
    expect((await post(stranger, `/api/facility-schedules/${s.id}/archive`, {})).status).toBe(404);
    expect((await post(provAdmin, `/api/facility-schedules/${s.id}/archive`, {})).status).toBe(404);
    await sql("INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)", [f.property, prov, f.admin.id]);
    expect((await post(provAdmin, `/api/facility-schedules/${s.id}/kind`, { kind: 'hardware', reason: 'provider fix', acknowledge_mismatch: true })).status).toBe(200);
    expect((await post(provAdmin, `/api/facility-schedules/${s.id}/archive`, {})).status).toBe(200);
    await sql("UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2", [f.property, prov]);
    expect((await post(provAdmin, `/api/facility-schedules/${s.id}/unarchive`, {})).status).toBe(404);
    expect((await sql('SELECT actor_organization_id FROM facility_schedule_events WHERE schedule_id=$1', [s.id])).rows.every((r: any) => r.actor_organization_id === prov)).toBe(true);
  });
  it('new versions cannot be added to an archived schedule', async () => {
    const f = await facility(); const s = await schedule(f, 'door', 'd.xlsx');
    await post(f.admin, `/api/facility-schedules/${s.id}/archive`, {});
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', key = `facility-schedules/${f.property}/${randomUUID()}.xlsx`;
    const r = await post(f.admin, '/api/facility-schedules', { property_id: f.property, schedule_id: s.id, kind: 'door', title: 't', original_filename: 'd.xlsx',
      storage_key: key, content_type: XLSX, byte_size: 10, sha256: 'c'.repeat(64) });
    expect(r.status).toBe(409); expect(r.body.error).toBe('schedule_archived');
  });
});