import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
// Multi-company milestone 5: OI staff tools (staff re-checked server-side on every request, every action audited),
// provider assignment requests, company + first-admin setup, platform staff management.
// (Fixture modelled on milestone 2.) Original M2 header:
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
import { generateTemporaryPassword } from '../src/routes/platform';
import { filterSort, parentChoices, needsProviderConfirmation, treeLines } from '../dashboard/src/lib/staffTools';

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


const S = () => tok('staff', 'oi');
const ev = async (action: string, target?: string) => (await sql(`SELECT * FROM platform_audit_events WHERE action=$1 ${target ? 'AND (target_id=$2 OR request_ref=$2)' : ''} ORDER BY id`, target ? [action, target] : [action])).rows;
const PLATFORM = [
  ['get', '/api/platform/me'], ['get', '/api/platform/facilities'], ['get', '/api/platform/providers'], ['get', '/api/platform/organizations'],
  ['get', '/api/platform/organizations/X/users'], ['put', '/api/platform/organizations/X/parent'], ['get', '/api/platform/provider-requests'],
  ['post', '/api/platform/provider-requests/X/approve'], ['post', '/api/platform/provider-requests/X/decline'], ['post', '/api/platform/companies'],
  ['get', '/api/platform/staff'], ['post', '/api/platform/staff'], ['delete', '/api/platform/staff/X'],
] as const;

describe('M5 staff gate', () => {
  it('every staff route refuses non-staff, including forged admin claims and an OI non-staff user', async () => {
    id.oiPlain = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','x')", [id.oiPlain, id.oi, id.oiPlain + '@example.invalid']);
    const orgsBefore = (await sql('SELECT count(*)::int n FROM organizations')).rows[0].n;
    for (const [m, p] of PLATFORM) for (const [u, o, r] of [['adminA', 'custA', 'admin'], ['vortexAdmin', 'vortex', 'admin'], ['techA', 'custA', 'admin'], ['oiPlain', 'oi', 'admin'], ['adminB', 'oi', 'admin']]) {
      const res = await (request(app) as any)[m](p.replace('X', id.custA)).set('Authorization', tok(u, o, r)).send({ reason: 'x', name: 'Forged', org_type: 'customer', admin_email: 'f@example.invalid', admin_full_name: 'F', email: 'x@example.invalid', parent_organization_id: null });
      expect([401, 403]).toContain(res.status);
    }
    expect((await sql('SELECT count(*)::int n FROM organizations')).rows[0].n).toBe(orgsBefore);
    expect((await request(app).get('/api/platform/me').set('Authorization', S())).body.staff).toBe(true);
  });
  it('staff reads are recorded in the audit log', async () => {
    for (const p of ['/api/platform/facilities', '/api/platform/providers', '/api/platform/organizations'])
      expect((await get(p, S())).status).toBe(200);
    const rows = (await sql("SELECT action FROM audit_log WHERE user_id=$1 AND action LIKE 'OI staff read:%'", [id.staff])).rows.map((r: any) => r.action);
    expect(rows).toEqual(expect.arrayContaining(['OI staff read: /facilities', 'OI staff read: /providers', 'OI staff read: /organizations']));
  });
});

describe('M5 parent-link editor', () => {
  it('requires a reason, refuses cross-type and internal, sets and clears with audit', async () => {
    const put = (o: string, b: any) => request(app).put(`/api/platform/organizations/${id[o]}/parent`).set('Authorization', S()).send(b);
    expect((await put('custB', { parent_organization_id: id.custA })).status).toBe(400);
    expect((await put('custB', { parent_organization_id: id.vortex, reason: 'x' })).body.error).toBe('organization_hierarchy_same_type_only');
    expect((await put('oi', { parent_organization_id: id.custA, reason: 'x' })).status).toBeGreaterThanOrEqual(400);
    expect((await put('custA', { parent_organization_id: id.childA, reason: 'cycle' })).status).toBeGreaterThanOrEqual(400);
    const ok = await put('custB', { parent_organization_id: id.custA, reason: 'synthetic merge' });
    expect(ok.status).toBe(200);
    expect(ok.body.tree.map((o: any) => o.id)).toEqual(expect.arrayContaining([id.custA, id.custB, id.childA]));
    expect((await ev('org_parent_changed', id.custB)).at(-1).reason).toBe('synthetic merge');
    const clr = await put('custB', { parent_organization_id: null, reason: 'synthetic split' });
    expect(clr.status).toBe(200);
    expect((await sql('SELECT parent_organization_id FROM organizations WHERE id=$1', [id.custB])).rows[0].parent_organization_id).toBeNull();
  });
  it('provider under provider needs explicit confirmation', async () => {
    const put = (b: any) => request(app).put(`/api/platform/organizations/${id.dhpace}/parent`).set('Authorization', S()).send(b);
    const r = await put({ parent_organization_id: id.vortex, reason: 'synthetic' });
    expect(r.status).toBe(409); expect(r.body.error).toBe('organization_provider_link_requires_confirmation');
    expect((await sql('SELECT parent_organization_id FROM organizations WHERE id=$1', [id.dhpace])).rows[0].parent_organization_id).toBeNull();
    expect((await put({ parent_organization_id: id.vortex, reason: 'synthetic', confirm_provider_link: true })).status).toBe(200);
    expect((await put({ parent_organization_id: null, reason: 'synthetic undo' })).status).toBe(200);
    expect((await sql('SELECT parent_organization_id FROM organizations WHERE id=$1', [id.dhpace])).rows[0].parent_organization_id).toBeNull();
  });
});

describe('M5 provider assignment requests', () => {
  const ask = (u: string, o: string, b: any, r = 'admin') => request(app).post('/api/provider-requests').set('Authorization', tok(u, o, r)).send(b);
  it('facility admin requests, withdraws, and staff approve/decline with assignment rows written and revoked', async () => {
    expect((await ask('techA', 'custA', { property_id: id.propA, provider_organization_id: id.dhpace, action: 'assign', reason: 'x' }, 'technician')).status).toBe(403);
    expect((await ask('vortexAdmin', 'vortex', { property_id: id.propA, provider_organization_id: id.dhpace, action: 'assign', reason: 'x' })).status).toBeGreaterThanOrEqual(400);
    expect((await ask('adminB', 'custB', { property_id: id.propA, provider_organization_id: id.dhpace, action: 'assign', reason: 'x' })).status).toBeGreaterThanOrEqual(400);
    const opts = await get('/api/provider-requests/options', tok('adminA', 'custA'));
    expect(opts.body.providers.map((p: any) => p.id)).toEqual(expect.arrayContaining([id.vortex, id.dhpace]));
    const w = await ask('adminA', 'custA', { property_id: id.propA, provider_organization_id: id.dhpace, action: 'assign', reason: 'synthetic need' });
    expect(w.status).toBe(201);
    expect((await ask('adminA', 'custA', { property_id: id.propA, provider_organization_id: id.dhpace, action: 'assign', reason: 'again' })).body.error).toBe('request_already_pending');
    expect((await request(app).post(`/api/provider-requests/${w.body.id}/withdraw`).set('Authorization', tok('admin2A', 'custA')).send({})).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post(`/api/provider-requests/${w.body.id}/withdraw`).set('Authorization', tok('adminA', 'custA')).send({})).status).toBe(200);
    expect((await ev('provider_assignment_request_withdrawn', w.body.id)).length).toBe(1);
    const a = await ask('adminA', 'custA', { property_id: id.propA, provider_organization_id: id.dhpace, action: 'assign', reason: 'synthetic need 2' });
    expect(a.status).toBe(201);
    // Providers never see requests.
    for (const [u, o] of [['vortexAdmin', 'vortex'], ['dhpaceAdmin', 'dhpace']])
      expect(JSON.stringify((await get('/api/provider-requests', tok(u, o))).body)).not.toContain(a.body.id);
    expect((await get('/api/platform/provider-requests', S())).body.map((r: any) => r.id)).toContain(a.body.id);
    expect((await request(app).post(`/api/platform/provider-requests/${a.body.id}/approve`).set('Authorization', S()).send({})).status).toBe(400);
    const ap = await request(app).post(`/api/platform/provider-requests/${a.body.id}/approve`).set('Authorization', S()).send({ reason: 'synthetic ok' });
    expect(ap.status).toBe(200);
    expect((await sql('SELECT count(*)::int n FROM facility_provider_assignments WHERE property_id=$1 AND provider_organization_id=$2 AND revoked_at IS NULL', [id.propA, id.dhpace])).rows[0].n).toBe(1);
    expect((await ev('provider_assignment_request_approved', a.body.id)).length).toBe(1);
    expect((await ev('provider_assignment_set')).length).toBeGreaterThanOrEqual(1);
    expect((await request(app).post(`/api/platform/provider-requests/${a.body.id}/decline`).set('Authorization', S()).send({ reason: 'late' })).status).toBeGreaterThanOrEqual(400);
    // Unassign request approved revokes the row; a declined request changes nothing.
    const u = await ask('adminA', 'custA', { property_id: id.propA, provider_organization_id: id.dhpace, action: 'unassign', reason: 'done' });
    const d = await ask('adminA', 'custA', { property_id: id.propA, provider_organization_id: id.vortex, action: 'unassign', reason: 'maybe' });
    expect((await request(app).post(`/api/platform/provider-requests/${d.body.id}/decline`).set('Authorization', S()).send({ reason: 'keep them' })).status).toBe(200);
    expect((await sql('SELECT count(*)::int n FROM facility_provider_assignments WHERE property_id=$1 AND provider_organization_id=$2 AND revoked_at IS NULL', [id.propA, id.vortex])).rows[0].n).toBe(1);
    expect((await request(app).post(`/api/platform/provider-requests/${u.body.id}/approve`).set('Authorization', S()).send({ reason: 'ok' })).status).toBe(200);
    expect((await sql('SELECT count(*)::int n FROM facility_provider_assignments WHERE property_id=$1 AND provider_organization_id=$2 AND revoked_at IS NULL', [id.propA, id.dhpace])).rows[0].n).toBe(0);
    expect((await ev('provider_assignment_request_declined', d.body.id)).length).toBe(1);
    expect((await ev('provider_assignment_revoked')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('M5 company + first admin setup', () => {
  it('creates a company and admin with forced password change; the temp password is returned once and never stored or logged', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }));
    const email = 'first-admin-' + randomUUID().slice(0, 8) + '@example.invalid';
    const r = await request(app).post('/api/platform/companies').set('Authorization', S()).send({ name: 'Synthetic New Co', org_type: 'service_partner', admin_email: email, admin_full_name: 'Synthetic First', reason: 'synthetic onboarding' });
    spies.forEach((s) => s.mockRestore());
    expect(r.status).toBe(201);
    const pw = r.body.temporary_password as string;
    expect(pw.length).toBeGreaterThanOrEqual(12);
    const u = (await sql('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    expect(u.must_change_password).toBe(true); expect(u.role).toBe('admin'); expect(u.organization_id).toBe(r.body.organization.id);
    expect(bcrypt.compareSync(pw, u.password_hash)).toBe(true);
    expect((await sql('SELECT org_type FROM organizations WHERE id=$1', [r.body.organization.id])).rows[0].org_type).toBe('service_partner');
    const dump = JSON.stringify((await sql('SELECT * FROM platform_audit_events')).rows) + JSON.stringify((await sql('SELECT * FROM audit_log')).rows);
    expect(dump).not.toContain(pw); expect(logs.join('\n')).not.toContain(pw);
    expect((await ev('org_created', r.body.organization.id)).length + (await ev('org_created')).filter((e: any) => e.target_org_id === r.body.organization.id).length).toBeGreaterThanOrEqual(1);
    expect((await ev('first_admin_invited')).length).toBeGreaterThanOrEqual(1);
    // Duplicate email refused; staff listing never returns the password.
    expect((await request(app).post('/api/platform/companies').set('Authorization', S()).send({ name: 'Dup', org_type: 'customer', admin_email: email, admin_full_name: 'D', reason: 'x' })).status).toBe(409);
    expect(JSON.stringify((await get(`/api/platform/organizations/${r.body.organization.id}/users`, S())).body)).not.toContain(pw);
    expect(generateTemporaryPassword()).not.toBe(generateTemporaryPassword());
  });

  it('creates one Main Portfolio for a customer in the same transaction and does not add a second for a provider facility', async () => {
    const post = (body: Record<string, unknown>) => request(app).post('/api/platform/companies').set('Authorization', S()).send(body);
    const email = 'cust-admin-' + randomUUID().slice(0, 8) + '@example.invalid';
    const customer = await post({ name: 'Synthetic Customer Co', org_type: 'customer', admin_email: email, admin_full_name: 'Synthetic Cust', reason: 'synthetic onboarding' });
    expect(customer.status).toBe(201);
    expect((await sql('SELECT name FROM portfolios WHERE organization_id=$1 ORDER BY name', [customer.body.organization.id])).rows).toEqual([{ name: 'Main Portfolio' }]);

    const providerEmail = 'prov-admin-' + randomUUID().slice(0, 8) + '@example.invalid';
    const provider = await post({ name: 'Synthetic Provider Co', org_type: 'service_partner', admin_email: providerEmail, admin_full_name: 'Synthetic Prov', reason: 'synthetic onboarding', create_provider_facility: true });
    expect(provider.status).toBe(201);
    expect((await sql('SELECT name FROM portfolios WHERE organization_id=$1', [provider.body.organization.id])).rows).toEqual([{ name: 'Main Portfolio' }]);
    expect((await sql('SELECT count(*)::int n FROM properties p JOIN portfolios f ON f.id=p.portfolio_id WHERE f.organization_id=$1', [provider.body.organization.id])).rows[0].n).toBe(1);

    const plainEmail = 'prov-plain-' + randomUUID().slice(0, 8) + '@example.invalid';
    const plain = await post({ name: 'Synthetic Provider Plain', org_type: 'service_partner', admin_email: plainEmail, admin_full_name: 'Synthetic Plain', reason: 'synthetic onboarding' });
    expect(plain.status).toBe(201);
    expect((await sql('SELECT count(*)::int n FROM portfolios WHERE organization_id=$1', [plain.body.organization.id])).rows[0].n).toBe(0);

    const rolled = await post({ name: 'Synthetic Customer Rollback', org_type: 'customer', admin_email: 'rollback-' + randomUUID().slice(0, 8) + '@example.invalid', admin_full_name: 'X', reason: 'synthetic', create_provider_facility: true });
    expect(rolled.body.error).toBe('provider_facility_requires_provider');
    expect((await sql("SELECT count(*)::int n FROM organizations WHERE name='Synthetic Customer Rollback'")).rows[0].n).toBe(0);
    expect((await sql("SELECT count(*)::int n FROM portfolios pf JOIN organizations o ON o.id=pf.organization_id WHERE o.name='Synthetic Customer Rollback'")).rows[0].n).toBe(0);
  });
});

describe('M5 platform staff management', () => {
  it('adds and removes staff with audit, refusing self and non-OI people', async () => {
    const add = (email: string, reason = 'synthetic hire') => request(app).post('/api/platform/staff').set('Authorization', S()).send({ email, reason });
    expect((await add(id.staff + '@example.invalid')).status).toBeGreaterThanOrEqual(400);
    expect((await add(id.adminA + '@example.invalid')).status).toBeGreaterThanOrEqual(400);
    const ok = await add(id.oiPlain + '@example.invalid');
    expect(ok.status).toBe(201);
    expect((await ev('staff_granted', id.oiPlain)).length).toBe(1);
    expect((await get('/api/platform/me', tok('oiPlain', 'oi'))).body.staff).toBe(true);
    expect((await add(id.oiPlain + '@example.invalid')).body.error).toBe('already_staff');
    expect((await request(app).delete('/api/platform/staff/' + id.staff).set('Authorization', S()).send({ reason: 'x' })).status).toBeGreaterThanOrEqual(400);
    const before = await sv('oiPlain');
    const rv = await request(app).delete('/api/platform/staff/' + id.oiPlain).set('Authorization', S()).send({ reason: 'synthetic leave' });
    expect(rv.status).toBe(200);
    expect(await sv('oiPlain')).toBe(before + 1);
    expect((await ev('staff_revoked', id.oiPlain)).length).toBe(1);
    expect((await get('/api/platform/me', tok('oiPlain', 'oi', 'admin', before + 1))).status).toBe(403);
    // Re-grant after revoke is covered in tests/staffRegrant.test.ts (with and without migration 20261030090600).
  });
});

describe('M5 staff tools helpers and wiring', () => {
  const O = (id: string, t: any, p: string | null = null, name = id) => ({ id, name, org_type: t, parent_organization_id: p, active_users: 0 });
  const orgs = [O('a', 'customer'), O('b', 'customer', 'a'), O('c', 'customer', 'b'), O('v', 'service_partner'), O('d', 'service_partner'), O('i', 'internal')];
  it('filterSort, parentChoices, confirmation and tree preview', () => {
    expect(filterSort([{ n: 'b', x: 2 }, { n: 'a', x: 1 }, { n: 'ab', x: 3 }], 'a', ['n'], 'x', -1).map((r) => r.x)).toEqual([3, 1]);
    expect(parentChoices(orgs as any, 'a').map((o) => o.id)).toEqual([]);
    expect(parentChoices(orgs as any, 'c').map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(parentChoices(orgs as any, 'd').map((o) => o.id)).toEqual(['v']);
    expect(parentChoices(orgs as any, 'i')).toEqual([]);
    expect(needsProviderConfirmation(orgs[4] as any, 'v')).toBe(true);
    expect(needsProviderConfirmation(orgs[4] as any, null)).toBe(false);
    expect(needsProviderConfirmation(orgs[1] as any, 'a')).toBe(false);
    expect(treeLines(orgs as any, 'd', 'v')).toEqual(['- v', '  - d  <-']);
  });
  it('dashboard wiring: staff route, staff-only sidebar link, request panel in facility settings, one-time password display', () => {
    const r = (p: string) => readFileSync(p, 'utf8');
    expect(r('dashboard/src/App.tsx')).toContain('path="/staff-tools"');
    expect(r('dashboard/src/components/Sidebar.tsx')).toMatch(/staff && <Link to="\/staff-tools"/);
    expect(r('dashboard/src/pages/FacilitySchedulesPage.tsx')).toContain('<RequestProviderPanel');
    const page = r('dashboard/src/pages/StaffToolsPage.tsx');
    expect(page).toContain('platformMe'); expect(page).not.toMatch(/console\.\w+\([^)]*password/i);
    expect(page).toContain('r.user_id !== me');
    expect(r('src/routes/platform.ts')).not.toMatch(/console\.\w+\([^)]*(temporary|password)/i);
  });
});
