import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
// Multi-company milestone 2: tree reads (opt-in ?scope=tree / X-OI-Scope: tree, GET only) across the
// converted routes, writes always single-company even when tree scope is requested, manager
// view-only, assignment-only provider access, team management on memberships with history + audit,
// and a sweep over EVERY mounted route with tree scope on. Disposable PGlite, synthetic data only.
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
const MARK_C = 'SYNTH-CHILD-' + randomUUID().slice(0, 8);
const tok = (u: string, org: string, role = 'admin', sv = 0) =>
  'Bearer ' + jwt.sign({ userId: id[u], organizationId: id[org], role, sessionVersion: sv }, process.env.JWT_SECRET!);
const get = (path: string, auth: string) => request(app).get(path).set('Authorization', auth);
const sv = async (u: string) => (await sql('SELECT session_version FROM users WHERE id=$1', [id[u]])).rows[0].session_version;
const childSnapshot = async () => JSON.stringify((await sql(
  `SELECT (SELECT json_agg(t ORDER BY t.id) FROM (SELECT * FROM portfolios WHERE organization_id=$1) t) pf,
          (SELECT json_agg(t ORDER BY t.id) FROM (SELECT p.* FROM properties p JOIN portfolios f ON f.id=p.portfolio_id WHERE f.organization_id=$1) t) pr,
          (SELECT json_agg(t ORDER BY t.id) FROM (SELECT b.* FROM buildings b WHERE b.property_id=$2) t) bl`, [id.childA, id.propChild])).rows);

beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const hash = bcrypt.hashSync(PASS, 4);
  const org = async (k: string, t: string, name = 'Synthetic ' + k) => { id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], name, t]); };
  const user = async (k: string, o: string, role: string) => { id[k] = randomUUID(); await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic',$4,$5)", [id[k], id[o], id[k] + '@example.invalid', role, hash]); };
  const prop = async (k: string, o: string, name: string) => {
    const pf = randomUUID(); await sql('INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,$3)', [pf, id[o], name + ' portfolio']); id[k + 'Pf'] = pf;
    id[k] = randomUUID(); await sql('INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,$3)', [id[k], pf, name]);
    id[k + 'Bldg'] = randomUUID(); await sql('INSERT INTO buildings(id,property_id,name) VALUES($1,$2,$3)', [id[k + 'Bldg'], id[k], name + ' building']);
  };
  await org('oi', 'internal'); await org('custA', 'customer'); await org('childA', 'customer', MARK_C + ' company'); await org('custB', 'customer', MARK_B + ' company');
  await org('vortex', 'service_partner'); await org('dhpace', 'service_partner');
  await user('adminA', 'custA', 'admin'); await user('admin2A', 'custA', 'admin'); await user('mgrA', 'custA', 'facilities_manager'); await user('techA', 'custA', 'technician');
  await user('adminB', 'custB', 'admin'); await user('personB', 'custB', 'technician'); await user('vortexAdmin', 'vortex', 'admin'); await user('dhpaceAdmin', 'dhpace', 'admin');
  await user('staff', 'oi', 'admin');
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic founder')", [id.staff]);
  await state.db.exec(`BEGIN; SELECT set_config('oi.actor_user_id','${id.staff}',true), set_config('oi.reason','synthetic tree',true);
    UPDATE organizations SET parent_organization_id='${id.custA}' WHERE id='${id.childA}'; COMMIT;`);
  await prop('propA', 'custA', 'Synthetic A facility'); await prop('propChild', 'childA', MARK_C); await prop('propB', 'custB', MARK_B);
  await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.propA, id.vortex, id.adminA]);
}, 180000);
afterAll(async () => { await state.db?.close(); });

const TREE_READS = ['/api/portfolio/portfolios', '/api/portfolio/properties'];
const ids = async (path: string, auth: string, q = '') => ((await get(path + q, auth)).body as any[]).map(p => p.id).sort();

describe('tree reads on converted routes', () => {
  it('parent admin and manager see child locations only when tree scope is requested (query or header)', async () => {
    for (const [u, r] of [['adminA', 'admin'], ['mgrA', 'facilities_manager']]) {
      expect(await ids('/api/portfolio/properties', tok(u, 'custA', r))).toEqual([id.propA]);
      expect(await ids('/api/portfolio/properties', tok(u, 'custA', r), '?scope=tree')).toEqual([id.propA, id.propChild].sort());
      expect(await ids('/api/portfolio/portfolios', tok(u, 'custA', r), '?scope=tree')).toEqual([id.propAPf, id.propChildPf].sort());
      const h = await get('/api/portfolio/properties', tok(u, 'custA', r)).set('X-OI-Scope', 'tree');
      expect(h.body.map((p: any) => p.id).sort()).toEqual([id.propA, id.propChild].sort());
    }
  });
  it('technicians, other customers and providers never get the child tree', async () => {
    for (const p of TREE_READS) {
      expect(JSON.stringify((await get(p + '?scope=tree', tok('techA', 'custA', 'technician'))).body)).not.toContain(MARK_C);
      for (const [u, o] of [['adminB', 'custB'], ['vortexAdmin', 'vortex'], ['dhpaceAdmin', 'dhpace']])
        expect(JSON.stringify((await get(p + '?scope=tree', tok(u, o))).body)).not.toContain(MARK_C);
    }
  });
  it('provider access stays assignment-only and Vortex/DH Pace never see each other or unassigned sites', async () => {
    expect(await ids('/api/portfolio/properties', tok('vortexAdmin', 'vortex'), '?scope=tree')).toEqual([id.propA]);
    expect(await ids('/api/portfolio/properties', tok('dhpaceAdmin', 'dhpace'), '?scope=tree')).toEqual([]);
  });
  it('a parent manager switched into the child is view-only', async () => {
    const s = await request(app).post('/api/auth/switch-company').set('Authorization', tok('mgrA', 'custA', 'facilities_manager')).send({ organization_id: id.childA });
    expect(s.body).toMatchObject({ role: 'viewer', access: 'tree_view' });
    const before = await childSnapshot();
    const w = await request(app).patch('/api/portfolio/properties/' + id.propChild).set('Authorization', 'Bearer ' + s.body.token).send({ name: 'renamed' });
    expect(w.status).toBeGreaterThanOrEqual(400);
    expect(await childSnapshot()).toBe(before);
  });
});

describe('team management on memberships', () => {
  it('adds an existing person to the active company with audit, and never to another company', async () => {
    const r = await request(app).post('/api/members/memberships').set('Authorization', tok('adminA', 'custA')).send({ email: id.personB + '@example.invalid', role: 'viewer' });
    expect(r.status).toBe(201); expect(r.body.organization_id).toBe(id.custA);
    expect((await get('/api/auth/users', tok('adminA', 'custA'))).body.map((u: any) => u.id)).toContain(id.personB);
    expect((await sql("SELECT count(*)::int n FROM platform_audit_events WHERE action='membership_added' AND target_id=$1 AND target_org_id=$2", [id.personB, id.custA])).rows[0].n).toBe(1);
    expect((await request(app).post('/api/members/memberships').set('Authorization', tok('adminA', 'custA')).send({ email: 'nobody-' + randomUUID() + '@example.invalid', role: 'viewer' })).body).toEqual({ error: 'person_not_found_or_inactive' });
    expect((await request(app).post('/api/members/memberships').set('Authorization', tok('techA', 'custA', 'technician')).send({ email: id.adminB + '@example.invalid', role: 'admin' })).status).toBe(403);
    expect((await sql('SELECT count(*)::int n FROM organization_memberships WHERE user_id=$1 AND organization_id=$2', [id.adminB, id.custA])).rows[0].n).toBe(0);
  });
  it('a role change in a non-home company changes only that membership, and is recorded', async () => {
    const before = await sv('personB');
    const r = await request(app).patch('/api/auth/users/' + id.personB).set('Authorization', tok('adminA', 'custA')).send({ role: 'inspector', reason: 'synthetic' });
    expect(r.status).toBe(200); expect(r.body.role).toBe('inspector');
    expect((await sql('SELECT role FROM users WHERE id=$1', [id.personB])).rows[0].role).toBe('technician');
    expect(await sv('personB')).toBe(before + 1);
    expect((await sql("SELECT count(*)::int n FROM user_history WHERE user_id=$1 AND organization_id=$2 AND change='role_change'", [id.personB, id.custA])).rows[0].n).toBe(1);
  });
  it('a non-home admin "deactivate" only removes the person from that company', async () => {
    const r = await request(app).patch('/api/auth/users/' + id.personB).set('Authorization', tok('adminA', 'custA')).send({ is_active: false, reason: 'synthetic' });
    expect(r.status).toBe(200);
    expect((await sql('SELECT is_active FROM users WHERE id=$1', [id.personB])).rows[0].is_active).toBe(true);
    expect((await get('/api/auth/users', tok('adminA', 'custA'))).body.map((u: any) => u.id)).not.toContain(id.personB);
    expect((await sql("SELECT count(*)::int n FROM platform_audit_events WHERE action='membership_removed' AND target_id=$1", [id.personB])).rows[0].n).toBe(1);
  });
  it('remove via DELETE /api/members/memberships works for non-home members and refuses home membership', async () => {
    await request(app).post('/api/members/memberships').set('Authorization', tok('adminA', 'custA')).send({ email: id.personB + '@example.invalid', role: 'viewer' });
    const d = await request(app).delete('/api/members/memberships/' + id.personB).set('Authorization', tok('adminA', 'custA')).send({ reason: 'synthetic' });
    expect(d.status).toBe(200);
    expect((await sql('SELECT is_active FROM organization_memberships WHERE user_id=$1 AND organization_id=$2', [id.personB, id.custA])).rows[0].is_active).toBe(false);
    expect((await request(app).delete('/api/members/memberships/' + id.techA).set('Authorization', tok('adminA', 'custA')).send({})).body.error).toBe('home_membership_use_deactivate');
    expect((await request(app).delete('/api/members/memberships/' + id.adminB).set('Authorization', tok('adminA', 'custA')).send({})).status).toBe(404);
  });
  it('home deactivation ends every membership; reactivation restores the home membership only', async () => {
    await request(app).post('/api/members/memberships').set('Authorization', tok('adminA', 'custA')).send({ email: id.personB + '@example.invalid', role: 'viewer' });
    const off = await request(app).patch('/api/auth/users/' + id.personB).set('Authorization', tok('adminB', 'custB')).send({ is_active: false, reason: 'left the company' });
    expect(off.status).toBe(200);
    const rows = async () => (await sql('SELECT organization_id, is_active FROM organization_memberships WHERE user_id=$1 ORDER BY is_home DESC', [id.personB])).rows;
    expect((await rows()).every((m: any) => !m.is_active)).toBe(true);
    const on = await request(app).patch('/api/auth/users/' + id.personB).set('Authorization', tok('adminB', 'custB')).send({ is_active: true, reason: 'returned' });
    expect(on.status).toBe(200);
    const after = await rows();
    expect(after.find((m: any) => m.organization_id === id.custB).is_active).toBe(true);
    expect(after.find((m: any) => m.organization_id === id.custA).is_active).toBe(false);
    const h = (await sql("SELECT change FROM user_history WHERE user_id=$1 AND organization_id=$2 ORDER BY id", [id.personB, id.custB])).rows.map((x: any) => x.change);
    expect(h).toEqual(['deactivate', 'reactivate']);
    expect(JSON.stringify((await sql('SELECT before_state, after_state FROM user_history')).rows)).not.toContain('password_hash');
  });
  it('cannot touch people outside the active company, nor remove the last admin', async () => {
    expect((await request(app).patch('/api/auth/users/' + id.adminB).set('Authorization', tok('adminA', 'custA')).send({ role: 'viewer' })).status).toBe(404);
    await request(app).patch('/api/auth/users/' + id.admin2A).set('Authorization', tok('adminA', 'custA')).send({ is_active: false, reason: 'synthetic' });
    expect((await request(app).patch('/api/auth/users/' + id.adminA).set('Authorization', tok('admin2A', 'custA')).send({ role: 'viewer' })).status).toBeGreaterThanOrEqual(400);
    expect((await sql('SELECT role FROM users WHERE id=$1', [id.adminA])).rows[0].role).toBe('admin');
  });
});

// ---- Every mounted route, tree scope on ----
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
const PUBLIC = [/^\/health$/, /^\/api\/qr\//, /^\/api\/invites\//, /^\/api\/auth\/(login|signup)$/, /^\/api\/account-recovery\//];
const SKIP_WRITE = [/^\/api\/auth\/(logout|switch-company|change-password)$/];
const fillWith = (v: string) => (path: string) => path.replace(/:[A-Za-z_]+/g, () => v);

describe('sweep over every mounted route with tree scope', () => {
  const routes = mountedRoutes();
  it('finds the API surface', () => { expect(routes.length).toBeGreaterThan(80); });
  it('no GET route leaks another company with tree scope, and the child tree reaches only parent admins/managers', async () => {
    const leaks: string[] = [];
    for (const r of routes.filter(r => r.method === 'get')) {
      if (PUBLIC.some(p => p.test(r.path))) continue;
      for (const v of [id.propB, id.propChild]) {
        for (const [u, o, role, mayChild] of [['adminA', 'custA', 'admin', true], ['mgrA', 'custA', 'facilities_manager', true], ['techA', 'custA', 'technician', false],
          ['vortexAdmin', 'vortex', 'admin', false], ['dhpaceAdmin', 'dhpace', 'admin', false]] as const) {
          const res = await get(fillWith(v)(r.path) + '?scope=tree', tok(u, o, role)).set('X-OI-Scope', 'tree');
          const text = JSON.stringify(res.body ?? '') + (res.text ?? '');
          if (text.includes(MARK_B) || text.includes(id.propB) || text.includes(id.propBBldg)) leaks.push(`B ${u} ${r.path} ${res.status}`);
          if (!mayChild && (text.includes(MARK_C) || text.includes(id.propChildBldg))) leaks.push(`child ${u} ${r.path} ${res.status}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  }, 600000);
  it('no write route changes child-company data from the parent company, even with tree scope requested', async () => {
    const before = await childSnapshot();
    const bad: string[] = [];
    for (const r of routes.filter(r => r.method !== 'get' && r.method !== 'head')) {
      if (PUBLIC.some(p => p.test(r.path)) || SKIP_WRITE.some(p => p.test(r.path))) continue;
      for (const [u, role] of [['mgrA', 'facilities_manager'], ['adminA', 'admin']]) {
        const res = await (request(app) as any)[r.method](fillWith(id.propChild)(r.path) + '?scope=tree').set('Authorization', tok(u, 'custA', role)).set('X-OI-Scope', 'tree')
          .send({ name: 'tree-write', property_id: id.propChild, portfolio_id: id.propChildPf, building_id: id.propChildBldg });
        if (JSON.stringify(res.body ?? '').includes(MARK_C)) bad.push(`${u} ${r.method} ${r.path} ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
    expect(await childSnapshot()).toBe(before);
  }, 600000);
});
