import { afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// Draft migration 20261030090600 (staff re-grant): offline PGlite, synthetic data only. Covers the API
// fallback without the migration, re-grant with it, the frozen row kept in append-only history,
// DB-level refusals, and the rollback (refuses once history exists).
const REGRANT = '20261030090600_platform_staff_regrant';
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
import { createApp } from '../src/app';
const app = createApp();
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const dbs: PGlite[] = [];
async function fresh(withRegrant: boolean) {
  const db = new PGlite(); dbs.push(db);
  await db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && (withRegrant || !n.startsWith(REGRANT))).sort()) await db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const id: Record<string, string> = {};
  const q = (s: string, a?: unknown[]) => db.query(s, a);
  id.oi = randomUUID(); await q("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic OI','internal')", [id.oi]);
  id.cust = randomUUID(); await q("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic Co','customer')", [id.cust]);
  for (const [k, o] of [['boss', 'oi'], ['alex', 'oi'], ['plain', 'oi'], ['cust', 'cust']]) {
    id[k + 'U'] = randomUUID();
    await q("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-hash')", [id[k + 'U'], id[o], id[k + 'U'] + '@example.invalid']);
  }
  await q("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic founder')", [id.bossU]);
  state.db = db;
  return { db, q, id };
}
const tok = (u: string, org: string, sv = 0) => 'Bearer ' + jwt.sign({ userId: u, organizationId: org, role: 'admin', sessionVersion: sv, mfaVerified: true }, process.env.JWT_SECRET!);
afterAll(async () => { for (const d of dbs) await d.close(); });

async function grantThenRevoke(id: Record<string, string>) {
  const S = tok(id.bossU, id.oi);
  expect((await request(app).post('/api/platform/staff').set('Authorization', S).send({ email: id.alexU + '@example.invalid', reason: 'first hire' })).status).toBe(201);
  expect((await request(app).delete('/api/platform/staff/' + id.alexU).set('Authorization', S).send({ reason: 'left' })).status).toBe(200);
  return S;
}

describe('staff re-grant', () => {
  it('without the migration the API falls back to 409 staff_previously_revoked and changes nothing', async () => {
    const { q, id } = await fresh(false);
    const S = await grantThenRevoke(id);
    const before = JSON.stringify((await q('SELECT * FROM platform_staff WHERE user_id=$1', [id.alexU])).rows);
    const r = await request(app).post('/api/platform/staff').set('Authorization', S).send({ email: id.alexU + '@example.invalid', reason: 'back again' });
    expect(r.status).toBe(409); expect(r.body.error).toBe('staff_previously_revoked');
    expect(JSON.stringify((await q('SELECT * FROM platform_staff WHERE user_id=$1', [id.alexU])).rows)).toBe(before);
  }, 120000);

  it('with the migration a revoked member is re-granted, the frozen row is kept in history, and it is audited', async () => {
    const { q, id } = await fresh(true);
    const S = await grantThenRevoke(id);
    const frozen = (await q('SELECT * FROM platform_staff WHERE user_id=$1', [id.alexU])).rows[0] as any;
    const r = await request(app).post('/api/platform/staff').set('Authorization', S).send({ email: id.alexU + '@example.invalid', reason: 'back again' });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ staff: true, regrant: true });
    const now = (await q('SELECT * FROM platform_staff WHERE user_id=$1', [id.alexU])).rows[0] as any;
    expect(now.revoked_at).toBeNull(); expect(now.granted_by_user_id).toBe(id.bossU); expect(now.grant_reason).toBe('back again');
    const h = (await q('SELECT * FROM platform_staff_grant_history WHERE user_id=$1', [id.alexU])).rows as any[];
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ grant_reason: frozen.grant_reason, revoke_reason: frozen.revoke_reason, revoked_by_user_id: frozen.revoked_by_user_id, archived_by_user_id: id.bossU, regrant_reason: 'back again' });
    expect(new Date(h[0].revoked_at).getTime()).toBe(new Date(frozen.revoked_at).getTime());
    expect((await q("SELECT is_platform_staff($1) ok", [id.alexU])).rows[0]).toEqual({ ok: true });
    const ev = (await q("SELECT after_state FROM platform_audit_events WHERE action='staff_granted' AND target_id=$1 ORDER BY id", [id.alexU])).rows as any[];
    expect(ev).toHaveLength(2); expect(ev[1].after_state).toMatchObject({ regrant: true });
    // Revoke + re-grant again keeps both frozen rows.
    expect((await request(app).delete('/api/platform/staff/' + id.alexU).set('Authorization', S).send({ reason: 'left again' })).status).toBe(200);
    expect((await request(app).post('/api/platform/staff').set('Authorization', S).send({ email: id.alexU + '@example.invalid', reason: 'third time' })).status).toBe(201);
    expect((await q('SELECT count(*)::int n FROM platform_staff_grant_history WHERE user_id=$1', [id.alexU])).rows[0]).toEqual({ n: 2 });
    // History is append-only.
    await expect(q('UPDATE platform_staff_grant_history SET regrant_reason=$1', ['x'])).rejects.toThrow(/append_only/);
    await expect(q('DELETE FROM platform_staff_grant_history')).rejects.toThrow(/append_only/);
    // Non-staff still refused at the API; active staff get already_staff.
    expect((await request(app).post('/api/platform/staff').set('Authorization', tok(id.custU, id.cust)).send({ email: id.alexU + '@example.invalid', reason: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/platform/staff').set('Authorization', S).send({ email: id.alexU + '@example.invalid', reason: 'x' })).body.error).toBe('already_staff');
  }, 120000);

  it('the database function refuses non-staff actors, self re-grant, missing reason and non-revoked rows', async () => {
    const { q, id } = await fresh(true);
    await grantThenRevoke(id);
    const call = (u: string, a: string, r: string) => q('SELECT platform_staff_regrant($1,$2,$3)', [u, a, r]);
    await expect(call(id.alexU, id.plainU, 'x')).rejects.toThrow(/requires_oi_staff/);
    await expect(call(id.alexU, id.custU, 'x')).rejects.toThrow(/requires_oi_staff/);
    await expect(call(id.alexU, id.bossU, ' ')).rejects.toThrow(/requires_reason/);
    await expect(call(id.bossU, id.bossU, 'x')).rejects.toThrow(/own_staff_access/);
    await expect(call(id.plainU, id.bossU, 'x')).rejects.toThrow(/not_revoked/);
    expect((await q('SELECT count(*)::int n FROM platform_staff_grant_history')).rows[0]).toEqual({ n: 0 });
  }, 120000);

  it('rollback refuses once history exists, and cleanly removes and re-applies when empty', async () => {
    const rb = fix(readFileSync(`docs/rollback/${REGRANT}_rollback.sql`, 'utf8'));
    const up = fix(readFileSync(`migrations/${REGRANT}.sql`, 'utf8'));
    const a = await fresh(true);
    await a.db.exec(rb);
    expect((await a.q("SELECT to_regclass('platform_staff_grant_history') t, to_regprocedure('platform_staff_regrant(uuid,uuid,text)') f")).rows[0]).toEqual({ t: null, f: null });
    await a.db.exec(up);
    const S = await grantThenRevoke(a.id);
    expect((await request(app).post('/api/platform/staff').set('Authorization', S).send({ email: a.id.alexU + '@example.invalid', reason: 'back' })).status).toBe(201);
    await expect(a.db.exec(rb)).rejects.toThrow(/not_empty_refusing_rollback/);
    expect((await a.q("SELECT to_regprocedure('platform_staff_regrant(uuid,uuid,text)') IS NOT NULL ok")).rows[0]).toEqual({ ok: true });
  }, 120000);

  it('the API role can only execute the function, not delete staff rows or write history', () => {
    const up = readFileSync(`migrations/${REGRANT}.sql`, 'utf8');
    expect(up).toMatch(/GRANT EXECUTE ON FUNCTION platform_staff_regrant\(UUID, UUID, TEXT\) TO oi_pr2_api/);
    expect(up).toMatch(/GRANT SELECT ON platform_staff_grant_history TO oi_pr2_api/);
    expect(up).not.toMatch(/GRANT[^;]*DELETE[^;]*oi_pr2_api/);
    expect(up).toMatch(/REVOKE ALL ON FUNCTION platform_staff_regrant/);
    expect(up).toContain('SECURITY DEFINER SET search_path = public');
  });
});
