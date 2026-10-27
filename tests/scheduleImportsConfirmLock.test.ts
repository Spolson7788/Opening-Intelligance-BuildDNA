import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { doorScheduleXlsx, hardwareDocx } from './fixtures/scheduleFixtures';
// Confirm-lock serialization (offline). PGlite has one session, so the mocked pool emulates Postgres
// row-lock semantics for `SELECT ... FROM properties ... FOR UPDATE`: a transaction blocks there until
// the transaction holding that property's lock commits or rolls back. BEGIN is deferred until the lock
// (or the first other statement) so waiting transactions do not share the open session.
const state = vi.hoisted(() => ({ db: null as any, files: new Map<string, Uint8Array>(), log: [] as { tx: number; sql: string; at: number }[],
  locks: new Map<string, Promise<void>>(), waited: 0, arrivals: 0, holdFor: 0, seq: 0, tick: 0 }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => {
    const tx = ++state.seq; let begun = false, pendingBegin = false, release: (() => void) | null = null;
    const end = () => { const r = release; release = null; r?.(); };
    return {
      query: async (s: string, a?: unknown[]) => {
        state.log.push({ tx, sql: s, at: ++state.tick });
        if (s === 'BEGIN') { pendingBegin = true; return { rows: [] }; }
        if (/FROM properties .*FOR UPDATE/.test(s) && pendingBegin && !begun) {
          state.arrivals++;
          const prop = (await state.db.query('SELECT property_id FROM schedule_imports WHERE id=$1', a)).rows[0]?.property_id ?? 'none';
          while (state.locks.has(prop)) { state.waited++; await state.locks.get(prop); }
          state.locks.set(prop, new Promise<void>((r) => { release = () => { state.locks.delete(prop); r(); }; }));
          state.log.push({ tx, sql: 'LOCK ACQUIRED', at: ++state.tick });
          // Hold the first lock until the competing confirm has arrived at its own lock statement.
          for (let i = 0; i < 300 && state.arrivals < state.holdFor; i++) await new Promise((r) => setTimeout(r, 10));
        }
        if (pendingBegin && !begun) { begun = true; await state.db.query('BEGIN'); }
        try { return await state.db.query(s, a); }
        finally { if (s === 'COMMIT' || s === 'ROLLBACK') { begun = false; pendingBegin = false; end(); } }
      },
      release: () => end(),
    };
  },
} }));
vi.mock('../src/services/storage', () => ({ getPresignedUploadUrl: async () => 'https://storage.invalid/x', getObjectBytes: async () => { throw new Error('no storage offline'); } }));
vi.mock('../src/services/scheduleFileReader', () => ({
  readScheduleFile: async (key: string) => { const f = state.files.get(key); if (!f) throw new Error('missing'); return f; },
}));
import { scheduleImportsRouter } from '../src/routes/scheduleImports';
const app = express(); app.use(express.json()); app.use('/api/schedule-imports', scheduleImportsRouter);
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) {
    await state.db.exec(readFileSync('migrations/' + name, 'utf8')
      .replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()'));
  }
}, 120000);
afterAll(async () => { await state.db?.close(); });

async function user(orgId: string) {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user','admin','not-a-real-password')", [id, orgId, id + '@example.invalid']);
  return { id, org: orgId, token: jwt.sign({ userId: id, organizationId: orgId, role: 'admin', sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function version(property: string, u: any, kind: string, type: string, bytes: Uint8Array) {
  const schedule = randomUUID(), id = randomUUID(), key = `facility-schedules/${property}/${id}.bin`;
  await sql("INSERT INTO facility_schedules(id,property_id,created_by_organization_id,created_by_user_id,kind,title,head_version) VALUES($1,$2,$3,$4,$5,'Synthetic',1)", [schedule, property, u.org, u.id, kind]);
  await sql(`INSERT INTO facility_schedule_versions(id,schedule_id,version,storage_key,original_filename,content_type,byte_size,sha256,uploaded_by_user_id,uploaded_by_organization_id)
    VALUES($1,$2,1,$3,'synthetic',$4,$5,$6,$7,$8)`, [id, schedule, key, type, bytes.byteLength, 'c'.repeat(64), u.id, u.org]);
  state.files.set(key, bytes); return id;
}
const auth = (u: any) => ({ Authorization: 'Bearer ' + u.token });
function resolveAll(preview: any) {
  const rows: Record<string, any> = {};
  for (const i of preview.plan.issues.filter((x: any) => x.code === 'duplicate_mark')) {
    i.row_ids.slice(1).forEach((id: string, n: number) => { rows[id] = { mark: `${i.key}-${String.fromCharCode(66 + n)}` }; });
  }
  return { rows, set_map: { '1': '1-EXT', X: null, '23': null } };
}

describe('schedule import confirm lock (7e15c8c follow-up)', () => {
  it('locks the facility row first and serializes concurrent confirms on the same facility', async () => {
    const owner = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic org','customer')", [owner]);
    const admin = await user(owner), portfolio = randomUUID(), property = randomUUID(), building = randomUUID();
    await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'P')", [portfolio, owner]);
    await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'F')", [property, portfolio]);
    await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Building A')", [building, property]);
    const door = await version(property, admin, 'door', XLSX, doorScheduleXlsx()), hw = await version(property, admin, 'hardware', DOCX, hardwareDocx());
    const mk = async () => (await request(app).post('/api/schedule-imports').set(auth(admin)).send({ building_id: building, door_version_id: door, hardware_version_id: hw })).body.id as string;
    const a = await mk(), b = await mk();
    const ra = resolveAll((await request(app).get('/api/schedule-imports/' + a).set(auth(admin))).body);
    const rb = resolveAll((await request(app).get('/api/schedule-imports/' + b).set(auth(admin))).body);
    state.log.length = 0; state.waited = 0; state.arrivals = 0; state.holdFor = 2;
    const [x, y] = await Promise.all([a, b].map((id, n) => request(app).post(`/api/schedule-imports/${id}/confirm`).set(auth(admin)).send({ resolutions: n ? rb : ra })));
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(state.arrivals).toBe(2);
    expect(state.waited).toBeGreaterThan(0); // the second confirm really waited on the facility lock
    const created = [x.body.result.openings_created, y.body.result.openings_created].sort();
    expect(created).toEqual([0, 12]); // second confirm re-planned after the first committed: no duplicates
    expect((await sql('SELECT count(*)::int n FROM openings WHERE building_id=$1', [building])).rows[0].n).toBe(12);
    const txs = [...new Set(state.log.filter(l => l.sql === 'BEGIN').map(l => l.tx))];
    for (const tx of txs) {
      const stmts = state.log.filter(l => l.tx === tx && l.sql !== 'LOCK ACQUIRED');
      expect(stmts[0].sql).toBe('BEGIN');
      expect(stmts[1].sql).toMatch(/^SELECT id FROM properties WHERE id=\(SELECT property_id FROM schedule_imports WHERE id=\$1\) FOR UPDATE$/);
      expect(stmts[2].sql).toMatch(/FROM schedule_imports WHERE id=\$1 FOR UPDATE/);
    }
    expect(state.log.some(l => /buildings.*FOR UPDATE/.test(l.sql))).toBe(false);
    const [first, second] = txs.map(tx => ({ commit: state.log.find(l => l.tx === tx && l.sql === 'COMMIT')!.at, lock: state.log.find(l => l.tx === tx && l.sql === 'LOCK ACQUIRED')!.at }))
      .sort((p, q) => p.lock - q.lock);
    expect(second.lock).toBeGreaterThan(first.commit); // critical sections do not overlap
  }, 120000);
});