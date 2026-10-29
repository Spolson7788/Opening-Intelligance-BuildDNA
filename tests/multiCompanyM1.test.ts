import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
// Multi-company milestone 1: login lists memberships (home default), the token carries the active
// company, requireAuth re-checks it every request, switch-company re-checks and reissues, parent-tree
// read visibility (admin + manager, manager view-only), assignment-only provider access, OI staff reads,
// and a sweep over EVERY mounted API route proving another company's data cannot be read.
// Disposable in-process PGlite, all migrations, synthetic data only.
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
import { createApp } from '../src/app';

const app = createApp();
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const id: Record<string, string> = {};
const PASS = 'synthetic-pass-' + randomUUID().slice(0, 8);
const MARK_B = 'SYNTH-B-PRIVATE-' + randomUUID().slice(0, 8);
const tok = (u: string, org: string, role = 'admin', sessionVersion = 0) =>
  'Bearer ' + jwt.sign({ userId: id[u], organizationId: id[org], role, sessionVersion }, process.env.JWT_SECRET!);
const get = (path: string, auth: string) => request(app).get(path).set('Authorization', auth);
const login = (u: string) => request(app).post('/api/auth/login').send({ email: id[u] + '@example.invalid', password: PASS });

beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const hash = bcrypt.hashSync(PASS, 4);
  const org = async (k: string, t: string) => { id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], k === 'custB' ? MARK_B + ' company' : 'Synthetic ' + k, t]); };
  const user = async (k: string, o: string, role: string) => { id[k] = randomUUID(); await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic',$4,$5)", [id[k], id[o], id[k] + '@example.invalid', role, hash]); };
  const prop = async (k: string, o: string, name: string) => {
    const pf = randomUUID(); await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Main')", [pf, id[o]]);
    id[k] = randomUUID(); await sql('INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,$3)', [id[k], pf, name]);
    id[k + 'Bldg'] = randomUUID(); await sql('INSERT INTO buildings(id,property_id,name) VALUES($1,$2,$3)', [id[k + 'Bldg'], id[k], name + ' building']);
  };
  await org('oi', 'internal'); await org('custA', 'customer'); await org('childA', 'customer'); await org('custB', 'customer');
  await org('vortex', 'service_partner'); await org('dhpace', 'service_partner');
  await user('adminA', 'custA', 'admin'); await user('mgrA', 'custA', 'facilities_manager'); await user('techA', 'custA', 'technician');
  await user('adminB', 'custB', 'admin'); await user('vortexAdmin', 'vortex', 'admin'); await user('dhpaceAdmin', 'dhpace', 'admin');
  await user('staff', 'oi', 'admin'); await user('multi', 'custA', 'technician');
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic founder')", [id.staff]);
  await state.db.exec(`BEGIN; SELECT set_config('oi.actor_user_id','${id.staff}',true), set_config('oi.reason','synthetic tree',true);
    UPDATE organizations SET parent_organization_id='${id.custA}' WHERE id='${id.childA}'; COMMIT;`);
  await sql("INSERT INTO organization_memberships(user_id,organization_id,role,created_by_user_id) VALUES($1,$2,'viewer',$3)", [id.multi, id.custB, id.adminB]);
  await prop('propA', 'custA', 'Synthetic A facility'); await prop('propChild', 'childA', 'Synthetic child facility'); await prop('propB', 'custB', MARK_B);
  await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.propA, id.vortex, id.adminA]);
}, 180000);
afterAll(async () => { await state.db?.close(); });

const propIds = async (auth: string, q = '') => ((await get('/api/portfolio/properties' + q, auth)).body as any[]).map(p => p.id).sort();

describe('login and active company', () => {
  it('login lists active memberships with the home company as default and the token carries it', async () => {
    const r = await login('multi');
    expect(r.status).toBe(200);
    expect(r.body.active_organization_id).toBe(id.custA);
    expect(r.body.companies.map((c: any) => [c.organization_id, c.role, c.is_home]).sort()).toEqual([[id.custA, 'technician', true], [id.custB, 'viewer', false]].sort());
    expect((jwt.decode(r.body.token) as any).organizationId).toBe(id.custA);
    expect(JSON.stringify(r.body)).not.toContain('password_hash');
  });
  it('a single-company login is unchanged apart from the company list', async () => {
    const r = await login('adminB');
    expect(r.body.companies).toHaveLength(1); expect(r.body.active_organization_id).toBe(id.custB);
  });
  it('a forged active company in the token is refused on every request', async () => {
    const r = await get('/api/auth/me', tok('adminA', 'custB'));
    expect(r.status).toBe(403); expect(r.body.error).toBe('membership_inactive');
    expect((await get('/api/portfolio/properties', tok('vortexAdmin', 'custA'))).status).toBe(403);
  });
});

describe('switch company', () => {
  it('re-checks membership, issues a new token, and the new company is used with its own role', async () => {
    const home = (await login('multi')).body.token;
    const s = await request(app).post('/api/auth/switch-company').set('Authorization', 'Bearer ' + home).send({ organization_id: id.custB });
    expect(s.status).toBe(200); expect(s.body.role).toBe('viewer');
    const me = await get('/api/auth/me', 'Bearer ' + s.body.token);
    expect(me.body).toMatchObject({ organization_id: id.custB, home_organization_id: id.custA, role: 'viewer' });
    expect(await propIds('Bearer ' + s.body.token)).toEqual([id.propB]);
    expect(await propIds('Bearer ' + home)).toEqual([id.propA]);
  });
  it('refuses companies the person does not belong to, without disclosing whether they exist', async () => {
    for (const target of [id.custB, randomUUID()]) {
      const r = await request(app).post('/api/auth/switch-company').set('Authorization', tok('adminA', 'custA')).send({ organization_id: target });
      expect(r.status).toBe(403); expect(r.body).toEqual({ error: 'membership_inactive' });
    }
    expect((await request(app).post('/api/auth/switch-company').set('Authorization', tok('vortexAdmin', 'vortex')).send({ organization_id: id.custA })).status).toBe(403);
  });
  it('removing a membership ends access to that company on the next request; deactivation and session checks still apply', async () => {
    const s = await request(app).post('/api/auth/switch-company').set('Authorization', tok('multi', 'custA', 'technician')).send({ organization_id: id.custB });
    await sql("UPDATE organization_memberships SET is_active=false, deactivated_at=now() WHERE user_id=$1 AND organization_id=$2", [id.multi, id.custB]);
    const r = await get('/api/portfolio/properties', 'Bearer ' + s.body.token);
    expect(r.status).toBe(403); expect(r.body.error).toBe('membership_inactive');
    expect((await get('/api/auth/me', tok('multi', 'custA', 'technician'))).status).toBe(200);
    await sql('UPDATE users SET session_version=session_version+1 WHERE id=$1', [id.multi]);
    expect((await get('/api/auth/me', tok('multi', 'custA', 'technician'))).body.error).toBe('session_revoked');
    await sql('UPDATE users SET is_active=false WHERE id=$1', [id.multi]);
    expect((await get('/api/auth/me', tok('multi', 'custA', 'technician', 1))).body.error).toBe('account_deactivated');
  });
});

describe('parent-tree visibility and provider separation', () => {
  it('a parent admin sees child locations with ?scope=tree and may switch in as admin', async () => {
    expect(await propIds(tok('adminA', 'custA'))).toEqual([id.propA]);
    expect(await propIds(tok('adminA', 'custA'), '?scope=tree')).toEqual([id.propA, id.propChild].sort());
    const s = await request(app).post('/api/auth/switch-company').set('Authorization', tok('adminA', 'custA')).send({ organization_id: id.childA });
    expect(s.body).toMatchObject({ role: 'admin', access: 'tree_admin' });
  });
  it('a parent facilities manager sees child locations but only view-only (role viewer) when switched in', async () => {
    expect(await propIds(tok('mgrA', 'custA', 'facilities_manager'), '?scope=tree')).toEqual([id.propA, id.propChild].sort());
    const s = await request(app).post('/api/auth/switch-company').set('Authorization', tok('mgrA', 'custA', 'facilities_manager')).send({ organization_id: id.childA });
    expect(s.body).toMatchObject({ role: 'viewer', access: 'tree_view' });
    const w = await request(app).post('/api/portfolio/properties').set('Authorization', 'Bearer ' + s.body.token).send({ portfolio_id: randomUUID(), name: 'should not exist' });
    expect([403, 404, 400]).toContain(w.status);
  });
  it('a technician gets no tree visibility', async () => {
    expect(await propIds(tok('techA', 'custA', 'technician'), '?scope=tree')).toEqual([id.propA]);
  });
  it('provider access is assignment-only: Vortex sees only its assigned facility, DH Pace sees nothing, neither sees the customer tree', async () => {
    expect(await propIds(tok('vortexAdmin', 'vortex'), '?scope=tree')).toEqual([id.propA]);
    expect(await propIds(tok('vortexAdmin', 'vortex'))).toEqual([id.propA]);
    expect(await propIds(tok('dhpaceAdmin', 'dhpace'), '?scope=tree')).toEqual([]);
    expect(await propIds(tok('dhpaceAdmin', 'dhpace'))).toEqual([]);
  });
});

describe('OI staff read access', () => {
  it('only active OI staff can read the platform overviews', async () => {
    const f = await get('/api/platform/facilities', tok('staff', 'oi'));
    expect(f.status).toBe(200); expect(f.body.map((x: any) => x.property_id)).toEqual(expect.arrayContaining([id.propA, id.propB, id.propChild]));
    expect((await get('/api/platform/providers', tok('staff', 'oi'))).status).toBe(200);
    for (const [u, o] of [['adminA', 'custA'], ['adminB', 'custB'], ['vortexAdmin', 'vortex']]) {
      expect((await get('/api/platform/facilities', tok(u, o))).status).toBe(403);
      expect((await get('/api/platform/providers', tok(u, o))).status).toBe(403);
    }
  });
  it('revoked staff lose access immediately', async () => {
    await sql("UPDATE platform_staff SET revoked_at=now(), revoked_by_user_id=$2, revoke_reason='synthetic' WHERE user_id=$1", [id.staff, id.adminA]);
    expect((await get('/api/platform/facilities', tok('staff', 'oi'))).status).toBe(403);
  });
});

// ---- Every mounted route ----
function mountedRoutes(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const layer of (app as any)._router.stack) {
    if (layer.route) { for (const m of Object.keys(layer.route.methods)) out.push({ method: m, path: layer.route.path }); continue; }
    if (layer.name !== 'router') continue;
    const base = String(layer.regexp.source).replace('^', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
    for (const sub of layer.handle.stack) if (sub.route) for (const m of Object.keys(sub.route.methods)) out.push({ method: m, path: base + sub.route.path });
  }
  return out.filter((r, i, a) => a.findIndex(x => x.method === r.method && x.path === r.path) === i);
}
// Public by design: health, public QR names, invite acceptance, login/signup/recovery.
const PUBLIC = [/^\/health$/, /^\/api\/qr\//, /^\/api\/invites\//, /^\/api\/auth\/(login|signup)$/, /^\/api\/account-recovery\//];
const fill = (path: string) => path.replace(/:[A-Za-z_]+/g, () => id.propB);

describe('cross-company sweep over every mounted route', () => {
  const routes = mountedRoutes();
  it('finds the API surface', () => { expect(routes.length).toBeGreaterThan(80); });
  it('positive control: the leak detector sees company B data when company B reads it', async () => {
    expect((await get('/api/portfolio/properties', tok('adminB', 'custB'))).text).toContain(MARK_B);
  });
  it('every non-public route refuses a token whose active company the person does not belong to', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      if (PUBLIC.some(p => p.test(r.path))) continue;
      const res = await (request(app) as any)[r.method](fill(r.path)).set('Authorization', tok('adminA', 'custB')).send({});
      if (res.status < 400 || res.status === 500 || JSON.stringify(res.body ?? '').includes(MARK_B)) leaks.push(`${r.method} ${r.path} ${res.status}`);
    }
    expect(leaks).toEqual([]);
  }, 300000);
  it("every GET route, called by company A with company B's ids, returns none of company B's data", async () => {
    const leaks: string[] = [];
    for (const r of routes.filter(r => r.method === 'get')) {
      if (PUBLIC.some(p => p.test(r.path))) continue;
      for (const auth of [tok('adminA', 'custA'), tok('vortexAdmin', 'vortex'), tok('mgrA', 'custA', 'facilities_manager')]) {
        const res = await get(fill(r.path) + (r.path.includes('/properties') ? '?scope=tree' : ''), auth);
        const text = JSON.stringify(res.body ?? '') + (res.text ?? '');
        if (text.includes(MARK_B) || text.includes(id.propB) || text.includes(id.propBBldg)) leaks.push(`${r.path} ${res.status}`);
      }
    }
    expect(leaks).toEqual([]);
  }, 300000);
});
