import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { LocationIndex, groupByLocation, needsTree, parseFilter, rollupByLocation, showCompanySwitcher, uniqueCompanies } from '../dashboard/src/lib/locationScope';
import { scopeHeaders, setTreeScope } from '../dashboard/src/lib/api';
// Multi-company milestone 3: the parent-company combined dashboard.
// Server: positive tree reads for EVERY converted route (closes the M2 gap) for parent admins and
// managers, nothing for technicians/other customers/providers; /api/locations; exports labelled with
// Location on every row; tree-wide exports admin / OI staff only (DB check), managers refused;
// writes stay single-company. Client: pure location helpers and wiring. PGlite, synthetic data only.
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
const MARK_B = 'SYNTH-B-' + randomUUID().slice(0, 8);
const MARK_C = 'SYNTH-CHILD-' + randomUUID().slice(0, 8);
const tok = (u: string, org: string, role = 'admin') =>
  'Bearer ' + jwt.sign({ userId: id[u], organizationId: id[org], role, sessionVersion: 0 }, process.env.JWT_SECRET!);
const get = (path: string, auth: string, tree = false) => { const r = request(app).get(path).set('Authorization', auth); return tree ? r.set('X-OI-Scope', 'tree') : r; };
const text = (r: any) => JSON.stringify(r.body ?? '') + (r.text ?? '');

beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const hash = bcrypt.hashSync('synthetic-' + randomUUID(), 4);
  const org = async (k: string, t: string, name = 'Synthetic ' + k) => { id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], name, t]); };
  const user = async (k: string, o: string, role: string) => { id[k] = randomUUID(); await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic',$4,$5)", [id[k], id[o], id[k] + '@example.invalid', role, hash]); };
  const site = async (k: string, o: string, name: string) => {
    id[k + 'Pf'] = randomUUID(); await sql('INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,$3)', [id[k + 'Pf'], id[o], name + ' portfolio']);
    id[k] = randomUUID(); await sql('INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,$3)', [id[k], id[k + 'Pf'], name]);
    id[k + 'Bldg'] = randomUUID(); await sql('INSERT INTO buildings(id,property_id,name) VALUES($1,$2,$3)', [id[k + 'Bldg'], id[k], name + ' building']);
    id[k + 'Open'] = randomUUID();
    await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,fire_rated,health_score) VALUES($1,$2,$3,$4,'door',true,40)", [id[k + 'Open'], id[k + 'Bldg'], name + '-OPEN', randomUUID()]);
    await sql("INSERT INTO hardware_components(id,opening_id,component_type,manufacturer,tracker_id,warranty_expiration) VALUES($1,$2,'closer',$3,$4,CURRENT_DATE + 30)", [randomUUID(), id[k + 'Open'], name + '-MFR', randomUUID()]);
  };
  await org('oi', 'internal'); await org('custA', 'customer'); await org('childA', 'customer', MARK_C + ' company'); await org('custB', 'customer', MARK_B + ' company');
  await org('vortex', 'service_partner'); await org('dhpace', 'service_partner');
  await user('adminA', 'custA', 'admin'); await user('mgrA', 'custA', 'facilities_manager'); await user('techA', 'custA', 'technician');
  await user('adminC', 'childA', 'admin'); await user('adminB', 'custB', 'admin');
  await user('vortexAdmin', 'vortex', 'admin'); await user('dhpaceAdmin', 'dhpace', 'admin'); await user('staff', 'oi', 'admin');
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic founder')", [id.staff]);
  await state.db.exec(`BEGIN; SELECT set_config('oi.actor_user_id','${id.staff}',true), set_config('oi.reason','synthetic tree',true);
    UPDATE organizations SET parent_organization_id='${id.custA}' WHERE id='${id.childA}'; COMMIT;`);
  await site('propA', 'custA', 'Synthetic A facility'); await site('propChild', 'childA', MARK_C); await site('propB', 'custB', MARK_B);
  await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.propA, id.vortex, id.adminA]);
  for (const [u, o, k, m] of [['adminC', 'childA', 'propChild', MARK_C], ['adminB', 'custB', 'propB', MARK_B]]) {
    expect((await request(app).post('/api/work-orders').set('Authorization', tok(u, o)).send({ opening_id: id[k + 'Open'], title: m + '-WO' })).status).toBe(201);
    expect((await request(app).post('/api/maintenance-schedules').set('Authorization', tok(u, o)).send({ opening_id: id[k + 'Open'], title: m + '-MS', interval_unit: 'months', interval_count: 6 })).status).toBe(201);
    await sql("INSERT INTO audit_log(organization_id,user_id,action,method,path,request_body,status_code) VALUES($1,$2,$3,'POST','/synthetic','{}',200)", [id[o], id[u], m + '-AUDIT']);
  }
}, 180000);
afterAll(async () => { await state.db?.close(); });

// Every GET route converted in M2 (plus the alerts fixed in M3), with what proves child data came back.
const CONVERTED = () => [
  '/api/portfolio/portfolios', '/api/portfolio/properties', '/api/openings', '/api/portfolio/capital-forecast/rollup',
  '/api/portfolio/compliance-alerts', '/api/portfolio/warranty-alerts', '/api/work-orders', '/api/maintenance-schedules', '/api/audit-log',
  '/api/portfolio/capital-forecast?property_id=' + id.propChild,
];

describe('M2 gap closed: every converted route returns child data under tree scope for parent admins and managers', () => {
  for (const [u, role] of [['adminA', 'admin'], ['mgrA', 'facilities_manager']]) {
    it(`${role}: child data with tree scope, none without, never another customer`, async () => {
      const missing: string[] = [], leaked: string[] = [];
      for (const p of CONVERTED()) {
        const t = await get(p, tok(u, 'custA', role), true);
        if (t.status !== 200 || !(text(t).includes(MARK_C) || text(t).includes(id.propChild))) missing.push(`${p} ${t.status}`);
        if (text(t).includes(MARK_B)) leaked.push('tree ' + p);
        const plain = await get(p, tok(u, 'custA', role));
        if (text(plain).includes(MARK_C)) leaked.push('plain ' + p);
        const q = await get(p + (p.includes('?') ? '&' : '?') + 'scope=tree', tok(u, 'custA', role));
        if (!(text(q).includes(MARK_C) || text(q).includes(id.propChild))) missing.push('query ' + p);
      }
      expect(missing).toEqual([]); expect(leaked).toEqual([]);
    });
  }
  it('technicians, the other customer and both providers never get child data', async () => {
    const leaked: string[] = [];
    for (const [u, o, role] of [['techA', 'custA', 'technician'], ['adminB', 'custB', 'admin'], ['vortexAdmin', 'vortex', 'admin'], ['dhpaceAdmin', 'dhpace', 'admin']])
      for (const p of CONVERTED()) { const t = text(await get(p, tok(u, o, role), true)); if (t.includes(MARK_C)) leaked.push(`${u} ${p}`); if (u !== 'adminB' && t.includes(MARK_B)) leaked.push(`${u} B ${p}`); }
    expect(leaked).toEqual([]);
  });
});

describe('/api/locations', () => {
  it('lists the tree companies and facilities for a parent admin, with export rights', async () => {
    const r = await get('/api/locations', tok('adminA', 'custA'), true);
    expect(r.body.tree).toBe(true); expect(r.body.can_export_tree).toBe(true);
    expect(r.body.companies.map((c: any) => c.id).sort()).toEqual([id.custA, id.childA].sort());
    expect(r.body.facilities.map((f: any) => [f.id, f.organization_id]).sort()).toEqual([[id.propA, id.custA], [id.propChild, id.childA]].sort());
  });
  it('a parent manager sees the tree view-only and may not export it', async () => {
    const r = await get('/api/locations', tok('mgrA', 'custA', 'facilities_manager'), true);
    expect(r.body.tree).toBe(true); expect(r.body.can_export_tree).toBe(false);
    expect(r.body.companies.find((c: any) => c.id === id.childA).access).toBe('tree_view');
  });
  it('technicians get no tree; providers only assigned facilities, without the owner company', async () => {
    expect((await get('/api/locations', tok('techA', 'custA', 'technician'), true)).body.tree).toBe(false);
    const v = await get('/api/locations', tok('vortexAdmin', 'vortex'), true);
    expect(v.body.facilities.map((f: any) => [f.id, f.organization_id])).toEqual([[id.propA, null]]);
    expect(text(v)).not.toContain('Synthetic custA');
    expect((await get('/api/locations', tok('dhpaceAdmin', 'dhpace'), true)).body.facilities).toEqual([]);
  });
});

describe('exports: Location on every row; tree-wide exports admin / OI staff only', () => {
  const EXPORTS = () => ['/api/export/openings.csv', '/api/export/hardware.csv', '/api/export/compliance-report.pdf?property_id=' + id.propChild, '/api/export/capital-forecast.pdf'];
  it('a parent admin gets tree-wide CSVs with a location column on every row', async () => {
    for (const p of ['/api/export/openings.csv', '/api/export/hardware.csv']) {
      const r = await get(p, tok('adminA', 'custA'), true);
      expect(r.status).toBe(200);
      const lines = r.text.trim().split(/\r?\n/);
      expect(lines[0].split(',')[0]).toBe('location');
      expect(r.text).toContain(`${MARK_C} company / ${MARK_C}`); expect(r.text).toContain('Synthetic custA / Synthetic A facility');
      expect(r.text).not.toContain(MARK_B);
      for (const l of lines.slice(1)) expect(l.split(',')[0].length).toBeGreaterThan(0);
    }
    expect((await get('/api/export/capital-forecast.pdf', tok('adminA', 'custA'), true)).status).toBe(200);
    expect((await get('/api/export/compliance-report.pdf?property_id=' + id.propChild, tok('adminA', 'custA'), true)).status).toBe(200);
  });
  it('a parent manager is refused every tree-wide export, but single-company exports still work and are labelled', async () => {
    for (const p of EXPORTS()) {
      const r = await get(p, tok('mgrA', 'custA', 'facilities_manager'), true);
      expect(r.status).toBe(403); expect(r.body.error).toBe('tree_export_admin_only');
    }
    const one = await get('/api/export/openings.csv', tok('mgrA', 'custA', 'facilities_manager'));
    expect(one.status).toBe(200); expect(one.text.split(/\r?\n/)[0].startsWith('location,')).toBe(true);
    expect(one.text).not.toContain(MARK_C);
  });
  it('the DB check backs the rule: an admin role claim in the token without admin membership is refused', async () => {
    const r = await get('/api/export/openings.csv', tok('mgrA', 'custA', 'admin'), true);
    expect([403]).toContain(r.status);
  });
  it('providers never export customer data beyond their assignment', async () => {
    const v = await get('/api/export/openings.csv', tok('vortexAdmin', 'vortex'), true);
    expect(v.text).not.toContain(MARK_C); expect(v.text).not.toContain(MARK_B);
    const d = await get('/api/export/openings.csv', tok('dhpaceAdmin', 'dhpace'), true);
    expect(d.text).not.toContain('Synthetic A facility');
  });
});

describe('writes stay on one stated location', () => {
  it('parent admin and manager cannot create in a child location from the parent, even with tree scope', async () => {
    const count = async () => (await sql('SELECT count(*)::int n FROM work_orders WHERE opening_id=$1', [id.propChildOpen])).rows[0].n;
    const before = await count();
    for (const [u, role] of [['adminA', 'admin'], ['mgrA', 'facilities_manager']]) {
      const r = await request(app).post('/api/work-orders?scope=tree').set('Authorization', tok(u, 'custA', role)).set('X-OI-Scope', 'tree').send({ opening_id: id.propChildOpen, title: 'tree write' });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect(await count()).toBe(before);
  });
});

// ---- client helpers ----
const LOCS = {
  active_organization_id: 'A', tree: true, can_export_tree: false,
  companies: [{ id: 'A', name: 'Parent', parent_organization_id: null, access: 'member', role: 'facilities_manager' },
    { id: 'C', name: 'Child', parent_organization_id: 'A', access: 'tree_view', role: 'viewer' },
    { id: 'G', name: 'Grandchild', parent_organization_id: 'C', access: 'tree_admin', role: 'admin' }],
  facilities: [{ id: 'pA', name: 'HQ', organization_id: 'A', building_ids: ['bA'] }, { id: 'pC', name: 'Depot', organization_id: 'C', building_ids: ['bC'] },
    { id: 'pG', name: 'Yard', organization_id: 'G', building_ids: [] }],
} as any;

describe('dashboard location helpers', () => {
  const idx = new LocationIndex(LOCS);
  it('labels every row with company / facility from property, building or name', () => {
    expect(idx.label({ property_id: 'pC' })).toBe('Child / Depot');
    expect(idx.label({ building_id: 'bA' })).toBe('Parent / HQ');
    expect(idx.label({ property_name: 'Yard' })).toBe('Grandchild / Yard');
    expect(idx.label({ organization_id: 'C' })).toBe('Child');
  });
  it('filters by all / branch (with descendants) / single location / this company', () => {
    const rows = [{ property_id: 'pA' }, { property_id: 'pC' }, { property_id: 'pG' }];
    expect(rows.filter(r => idx.inFilter(r, { kind: 'all' }))).toHaveLength(3);
    expect(rows.filter(r => idx.inFilter(r, { kind: 'branch', orgId: 'C' })).map(r => r.property_id)).toEqual(['pC', 'pG']);
    expect(rows.filter(r => idx.inFilter(r, { kind: 'facility', propertyId: 'pG' })).map(r => r.property_id)).toEqual(['pG']);
    expect(rows.filter(r => idx.inFilter(r, { kind: 'company' })).map(r => r.property_id)).toEqual(['pA']);
  });
  it('write gating: own company writable, view-only child hidden, tree-admin child needs a switch', () => {
    expect(idx.writeState({ property_id: 'pA' })).toBe('write');
    expect(idx.writeState({ property_id: 'pC' })).toBe('view_only');
    expect(idx.writeState({ property_id: 'pG' })).toBe('switch_to_edit');
    expect(idx.createTargets().map(c => c.id)).toEqual(['A', 'G']);
  });
  it('rolls up totals and health per location with a grand total, and groups rows', () => {
    const r = rollupByLocation([{ property_id: 'pA', health_score: 40 }, { property_id: 'pA', health_score: 80 }, { property_id: 'pC', health_score: 60 }, { property_id: 'pC', health_score: null }], idx);
    expect(r.total).toMatchObject({ openings: 4, assessed: 3, avg_health: 60, urgent: 1, near_term: 1 });
    expect(r.locations.find(l => l.facility_id === 'pA')).toMatchObject({ openings: 2, avg_health: 60, urgent: 1 });
    expect(groupByLocation([{ property_id: 'pC' }, { property_id: 'pA' }, { property_id: 'pC' }], idx).map(([k, v]) => [k, v.length])).toEqual([['Child / Depot', 2], ['Parent / HQ', 1]]);
  });
  it('company switcher hidden with one company; filter parsing and tree header only on reads', () => {
    expect(showCompanySwitcher([{ organization_id: 'A', name: 'x', role: 'admin', is_home: true }, { organization_id: 'A', name: 'x', role: 'admin', is_home: false }])).toBe(false);
    expect(uniqueCompanies([{ organization_id: 'A', name: 'x', role: 'admin', is_home: true }, { organization_id: 'B', name: 'y', role: 'viewer', is_home: false }])).toHaveLength(2);
    expect(parseFilter('garbage')).toEqual({ kind: 'company' }); expect(parseFilter(JSON.stringify({ kind: 'branch', orgId: 'C' }))).toEqual({ kind: 'branch', orgId: 'C' });
    expect(needsTree({ kind: 'company' })).toBe(false); expect(needsTree({ kind: 'all' })).toBe(true);
    setTreeScope(true);
    expect(scopeHeaders('GET')).toEqual({ 'X-OI-Scope': 'tree' }); expect(scopeHeaders('POST')).toEqual({}); expect(scopeHeaders('PATCH')).toEqual({});
    setTreeScope(false); expect(scopeHeaders('GET')).toEqual({});
  });
  it('the dashboard is wired: header switcher, location column on every list, create pages need one location', () => {
    const read = (f: string) => readFileSync('dashboard/src/' + f, 'utf8');
    expect(read('components/Sidebar.tsx')).toContain('<LocationBar />');
    for (const p of ['DashboardPage', 'WorkOrdersPage', 'MaintenanceSchedulesPage', 'ComplianceAlertsPage', 'AuditLogPage', 'CapitalForecastPage', 'OpeningDetailPage'])
      expect(read(`pages/${p}.tsx`)).toMatch(/loc\.label\(/);
    const appSrc = read('App.tsx');
    for (const p of ['/properties/new', '/openings/new', '/openings/import', '/hardware/import', '/schedule-imports/new'])
      expect(appSrc).toContain(`<Route path="${p}" element={<RequireAuth><RequireOneLocation>`);
  });
});
