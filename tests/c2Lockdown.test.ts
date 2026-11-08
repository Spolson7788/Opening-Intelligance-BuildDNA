import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// C2 lock-down (Stephan, 2026-10-28): signup closed (410, no rows), session bump on role/active
// change, accurate auth.ts comment, signup removed from the dashboard, and the field app wipes ALL
// on-device OI data on 401 session_revoked / 403 account_deactivated. Disposable in-process SQL and
// fake IndexedDB only; synthetic data only.
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
import { authRouter } from '../src/routes/auth';
import { closeFieldAppDb, getDb, loadAuth, putSyncOperation, saveAuth } from '../field-app/src/lib/db';
import { fetchMe, isSessionEnded } from '../field-app/src/lib/api';

const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const ids: Record<string, string> = {};
const bearer = (id: string, orgId: string, role: string, sessionVersion = 0) =>
  'Bearer ' + jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion }, process.env.JWT_SECRET!);
async function user(orgId: string, role: string) {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user',$4,'not-a-real-password')", [id, orgId, id + '@example.invalid', role]);
  return id;
}
const version = async (id: string) => (await sql('SELECT session_version FROM users WHERE id=$1', [id])).rows[0].session_version;
const count = async (table: string) => (await sql(`SELECT count(*)::int AS c FROM ${table}`)).rows[0].c;

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + name, 'utf8')));
  ids.org = randomUUID();
  await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic C2 org','customer')", [ids.org]);
  ids.admin = await user(ids.org, 'admin'); ids.admin2 = await user(ids.org, 'admin'); ids.tech = await user(ids.org, 'technician');
}, 60000);

describe('C2 signup is closed', () => {
  it('returns 410 signup_closed outside the vitest fixture and creates no organization or user', async () => {
    const saved = process.env.VITEST; delete process.env.VITEST;
    try {
      const orgs = await count('organizations'), users = await count('users');
      const res = await request(app).post('/api/auth/signup').send({ organization_name: 'Should not exist', email: 'c2-signup@example.invalid', password: 'x'.repeat(12), full_name: 'X' });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('signup_closed');
      expect(await count('organizations')).toBe(orgs);
      expect(await count('users')).toBe(users);
    } finally { process.env.VITEST = saved; }
  });
});

describe('C2 role or active changes end existing sessions', () => {
  it('a role change bumps session_version and the old token gets 401 session_revoked', async () => {
    const old = bearer(ids.tech, ids.org, 'technician');
    expect((await request(app).get('/api/auth/me').set('Authorization', old)).status).toBe(200);
    const before = await version(ids.tech);
    const r = await request(app).patch('/api/auth/users/' + ids.tech).set('Authorization', bearer(ids.admin, ids.org, 'admin')).send({ role: 'inspector' });
    expect(r.status).toBe(200);
    expect(await version(ids.tech)).toBe(before + 1);
    const denied = await request(app).get('/api/auth/me').set('Authorization', old);
    expect(denied.status).toBe(401); expect(denied.body.error).toBe('session_revoked');
    expect((await request(app).get('/api/auth/me').set('Authorization', bearer(ids.admin, ids.org, 'admin'))).status).toBe(200);
  });
  it('deactivation bumps session_version and the old token gets 403 account_deactivated; reactivation bumps again', async () => {
    const v = await version(ids.tech);
    const old = bearer(ids.tech, ids.org, 'inspector', v);
    const admin = bearer(ids.admin, ids.org, 'admin');
    expect((await request(app).patch('/api/auth/users/' + ids.tech).set('Authorization', admin).send({ is_active: false })).status).toBe(200);
    expect(await version(ids.tech)).toBe(v + 1);
    const denied = await request(app).get('/api/auth/me').set('Authorization', old);
    expect(denied.status).toBe(403); expect(denied.body.error).toBe('account_deactivated');
    expect((await request(app).patch('/api/auth/users/' + ids.tech).set('Authorization', admin).send({ is_active: true })).status).toBe(200);
    expect(await version(ids.tech)).toBe(v + 2);
    const revoked = await request(app).get('/api/auth/me').set('Authorization', old);
    expect(revoked.status).toBe(401); expect(revoked.body.error).toBe('session_revoked');
  });
  it('a PATCH that changes nothing does not end the session', async () => {
    const v = await version(ids.admin2);
    expect((await request(app).patch('/api/auth/users/' + ids.admin2).set('Authorization', bearer(ids.admin, ids.org, 'admin')).send({ role: 'admin', is_active: true })).status).toBe(200);
    expect(await version(ids.admin2)).toBe(v);
  });
  it('the auth.ts comment no longer claims live sessions survive deactivation', () => {
    const src = readFileSync('src/routes/auth.ts', 'utf8');
    expect(src).not.toContain('keeps working until it naturally');
    expect(src).not.toContain('Known limitation, stated plainly');
    expect(src).toContain('session_revoked');
  });
});

describe('C2 dashboard has no signup', () => {
  it('the signup page, route, link and API call are gone', () => {
    expect(existsSync('dashboard/src/pages/SignupPage.tsx')).toBe(false);
    expect(readFileSync('dashboard/src/App.tsx', 'utf8')).not.toMatch(/signup/i);
    expect(readFileSync('dashboard/src/lib/api.ts', 'utf8')).not.toContain('/auth/signup');
    expect(readFileSync('dashboard/src/lib/AuthContext.tsx', 'utf8')).not.toMatch(/signup/i);
    expect(readFileSync('dashboard/src/pages/LoginPage.tsx', 'utf8')).not.toContain('/signup');
  });
});

// ---- field app wipe ------------------------------------------------------------------------------
const accountA = { token: 'token-a', userId: randomUUID(), organizationId: randomUUID(), role: 'technician' };
const accountB = { token: 'token-b', userId: randomUUID(), organizationId: randomUUID(), role: 'technician' };
async function seedDevice() {
  await saveAuth(accountA);
  const db: any = await getDb();
  const op = randomUUID(), opening = randomUUID();
  await db.put('openings', { id: opening, opening_code: 'SYN-1' });
  await db.put('outbox', { id: randomUUID(), kind: 'service_event', payload: {}, createdAt: 1, attempts: 0, status: 'pending' });
  await db.put('photoOutbox', { id: randomUUID(), openingId: opening, blob: new Uint8Array([1]), contentType: 'image/jpeg', relatedEntityType: 'opening', createdAt: 1, attempts: 0, status: 'pending' });
  await db.put('entities', { key: 'k-' + op, openingId: opening, syncState: 'pending', organizationId: accountA.organizationId });
  await db.put('operations', { operationId: op, openingId: opening, state: 'pending' });
  await db.put('media', { photoId: randomUUID(), openingId: opening, uploadState: 'pending', targetType: 'opening', targetId: opening });
  await db.put('syncReceipts', { operationId: randomUUID(), openingId: opening, entityId: randomUUID() });
  await db.put('conflicts', { conflictId: randomUUID(), openingId: opening, resolutionState: 'open' });
  await db.put('openingSnapshots', { openingId: opening, organizationId: accountA.organizationId });
  await db.put('settings', { key: 'facility-sync', value: 1 });
}
async function storeCounts() {
  const db: any = await getDb();
  const out: Record<string, number> = {};
  for (const name of Array.from(db.objectStoreNames) as string[]) out[name] = await db.count(name);
  return out;
}
const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeFieldAppDb();
  await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase('opening-intel-field'); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
});

describe('C2 field app wipes all OI data when access ends', () => {
  for (const [status, error] of [[401, 'session_revoked'], [403, 'account_deactivated']] as const) {
    it(`${status} ${error}: every store is emptied, including unsynced work, and nothing is written back`, async () => {
      await seedDevice();
      const before = await storeCounts();
      expect(Object.keys(before).length).toBe(11);
      for (const n of Object.values(before)) expect(n).toBeGreaterThan(0);
      vi.stubGlobal('fetch', vi.fn(async () => json(status, { error, reference: randomUUID() })));
      const failure = await fetchMe().catch((e: unknown) => e);
      expect(isSessionEnded(failure)).toBe(true);
      expect(total(await storeCounts())).toBe(0);
      expect(await loadAuth()).toBeUndefined();
      await expect(putSyncOperation({ operationId: randomUUID() } as any)).rejects.toThrow('oi_data_wiped');
      await saveAuth(accountA); // a fresh sign-in re-enables local storage
      await putSyncOperation({ operationId: randomUUID(), openingId: randomUUID(), state: 'pending' } as any);
      expect((await storeCounts()).operations).toBe(1);
    });
  }
  it('an expired app token drops only the saved sign-in and leaves unsynced work', async () => {
    await seedDevice();
    const before = await storeCounts();
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'invalid_token', reference: randomUUID() })));
    const failure = await fetchMe().catch((e: unknown) => e);
    expect(isSessionEnded(failure)).toBe(false);
    expect(await loadAuth()).toBeUndefined();
    const after = await storeCounts();
    expect(after.auth).toBe(0);
    for (const name of Object.keys(before)) if (name !== 'auth') expect(after[name]).toBe(before[name]);
  });
  it('does not wipe on other refusals (missing reference, hosting gate HTML)', async () => {
    await seedDevice();
    const before = total(await storeCounts());
    const responses = [
      () => json(401, { error: 'session_revoked' }),
      () => json(403, { error: 'forbidden', reference: randomUUID() }),
      () => new Response('<html>sign in</html>', { status: 401, headers: { 'content-type': 'text/html' } }),
    ];
    for (const make of responses) {
      vi.stubGlobal('fetch', vi.fn(async () => make()));
      const failure = await fetchMe().catch((e: unknown) => e);
      expect(isSessionEnded(failure)).toBe(false);
      expect(total(await storeCounts())).toBe(before);
    }
  });
  it("never wipes another person's data if a different account signed in meanwhile", async () => {
    await seedDevice();
    const before = total(await storeCounts());
    vi.stubGlobal('fetch', vi.fn(async () => { await saveAuth(accountB); return json(401, { error: 'session_revoked', reference: randomUUID() }); }));
    const failure = await fetchMe().catch((e: unknown) => e);
    expect(isSessionEnded(failure)).toBe(false);
    expect(total(await storeCounts())).toBe(before);
    expect((await loadAuth())?.userId).toBe(accountB.userId);
  });
});
