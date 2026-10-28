import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ db: null as any }));
// M4 v2: field app sync of imported openings, loose code key, comparison report index. Synthetic data only.
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/storage', () => ({ getPresignedUploadUrl: async (key: string) => 'https://storage.invalid/' + key }));
import { scheduleImportsRouter } from '../src/routes/scheduleImports';
import { scheduleComparisonsRouter } from '../src/routes/scheduleComparisons';
import { openingsRouter } from '../src/routes/openings';
import { hardwareRouter } from '../src/routes/hardware';
import { looseCodeKey } from '../src/services/scheduleComparison';
import { searchKey, sortFacilityOpenings, filterFacilityOpenings, prefetchOpenings, facilityOpeningsCacheKey, comparisonReportHref, COMPARISON_REPORT_ROLES } from '../field-app/src/lib/facilityOpenings';
import { hardwareSetLabel } from '../dashboard/src/lib/comparisonUi';
const app = express(); app.use(express.json());
app.use('/api/schedule-imports', scheduleImportsRouter); app.use('/api/schedule-comparisons', scheduleComparisonsRouter);
app.use('/api/openings', openingsRouter); app.use('/api/hardware', hardwareRouter);
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + name, 'utf8')));
}, 120000);
afterAll(async () => { await state.db?.close(); });
async function org() { const id = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic org','customer')", [id]); return id; }
async function user(orgId: string, role = 'admin') {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user',$4,'not-a-real-password')", [id, orgId, id + '@example.invalid', role]);
  return { id, org: orgId, role, token: jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function version(f: any, kind: string, filename: string) {
  const id = randomUUID(), v = randomUUID();
  await sql("INSERT INTO facility_schedules(id,property_id,created_by_organization_id,created_by_user_id,kind,title,head_version) VALUES($1,$2,$3,$4,$5,'Synthetic schedule',1)", [id, f.property, f.owner, f.admin.id, kind]);
  await sql(`INSERT INTO facility_schedule_versions(id,schedule_id,version,storage_key,original_filename,content_type,byte_size,sha256,uploaded_by_user_id,uploaded_by_organization_id)
    VALUES($1,$2,1,$3,$4,$5,10,$6,$7,$8)`, [v, id, 'facility-schedules/' + f.property + '/' + v + '.x', filename, filename.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'c'.repeat(64), f.admin.id, f.owner]);
  return v;
}
type Row = { mark: string; config?: string; w?: number; h?: number; t?: number; door?: string; frame?: string; fire?: number | null; set?: string | null };
async function draft(f: any, rows: Row[]) {
  const id = randomUUID(), door = await version(f, 'door', 'synthetic-doors.xlsx'), hw = await version(f, 'hardware', 'synthetic-hw.docx');
  await sql("INSERT INTO schedule_imports(id,property_id,building_id,door_version_id,hardware_version_id,created_by_user_id,created_by_organization_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [id, f.property, f.building, door, hw, f.admin.id, f.owner]);
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    const rid = randomUUID(); ids.push(rid);
    await sql(`INSERT INTO schedule_rows(id,import_id,row_kind,source_sheet,source_row,raw,door_mark_raw,door_mark,configuration,width_in,height_in,thickness_in,door_material,frame_material,fire_rating_raw,fire_rating_minutes,hw_ref_raw,hw_set_key)
      VALUES($1,$2,'door','Sheet1',$3,'{}'::jsonb,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [rid, id, i + 2, r.mark, r.config ?? 'single', r.w ?? 36, r.h ?? 84, r.t ?? 1.75, r.door ?? 'HM', r.frame ?? 'HM', r.fire ? `${r.fire} min` : null, r.fire ?? null, r.set === undefined ? 'S1' : r.set]);
  }
  const set = randomUUID();
  await sql("INSERT INTO schedule_hardware_sets(id,import_id,set_key,heading_raw,source_table) VALUES($1,$2,'S1','Set S1',1)", [set, id]);
  for (const [pos, type, mfr, cat, qty] of [[1, 'hinge', 'Ives', '5BB1', 3], [2, 'lockset', 'Schlage', 'ND50', 1], [3, 'closer', 'LCN', '4040XP', 1]] as const)
    await sql(`INSERT INTO schedule_set_items(id,set_id,import_id,position,qty,description,catalog,manufacturer,finish,item_type,component_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'626',$9,$9)`,
      [randomUUID(), set, id, pos, qty, `${type} synthetic`, cat, mfr, type]);
  return { id, rows: ids };
}
async function facility() {
  const owner = await org(), admin = await user(owner), portfolio = randomUUID(), property = randomUUID(), building = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio, owner]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [property, portfolio]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')", [building, property]);
  return { owner, admin, property, building };
}
const post = (u: any, path: string, body: any = {}) => request(app).post(path).set('Authorization', 'Bearer ' + u.token).send(body);
const get = (u: any, path: string) => request(app).get(path).set('Authorization', 'Bearer ' + u.token);
const patch = (u: any, path: string, body: any) => request(app).patch(path).set('Authorization', 'Bearer ' + u.token).send(body);
async function confirmed() {
  const f: any = await facility();
  const d = await draft(f, [{ mark: '101' }, { mark: '102' }]);
  const c = await post(f.admin, `/api/schedule-imports/${d.id}/confirm`, { resolutions: {} });
  expect(c.status).toBe(200);
  return { f, d };
}

describe('M4 v2 loose opening-code key', () => {
  it('ignores hyphens, dots, underscores, spaces, punctuation, case, leading zeros and a Door prefix', () => {
    for (const v of ['101-A', '101A', '101 a', 'Door 101-A', 'DOOR-101A', 'dr 0101.a', '101_A', '#101-A.']) expect(looseCodeKey(v)).toBe('101A');
    expect(looseCodeKey('D104')).toBe('D104');
    expect(looseCodeKey('Doorway 5')).toBe('DOORWAY5');
    expect(looseCodeKey('1-01')).toBe('1.1'); expect(looseCodeKey('11')).toBe('11');
    expect(looseCodeKey('0')).toBe('0'); expect(looseCodeKey('---')).toBe(null); expect(looseCodeKey(null)).toBe(null);
  });
  it('dashboard shows a one-line hardware set verdict', () => {
    expect(hardwareSetLabel({ hardware_set: { set_key: 'S1', heading: null, status: 'matches', scheduled_items: 3, field_items: 3, missing: 0, extra: 0, changed: 0 } })).toBe('Set S1: matches');
    expect(hardwareSetLabel({ hardware_set: { set_key: null, heading: null, status: 'differs', scheduled_items: 0, field_items: 1, missing: 0, extra: 1, changed: 0 } })).toBe('No scheduled set: differs (0 missing, 1 extra, 0 changed)');
    expect(hardwareSetLabel({ hardware_set: null })).toBe('');
  });
});

describe('M4 v2 field app facility openings helpers', () => {
  const list = [
    { id: 'c', opening_code: 'B-200', schedule_door_mark: '200', floor_label: '2', completion_state: 'complete' },
    { id: 'a', opening_code: 'B-101A', schedule_door_mark: '101A', floor_label: '1', completion_state: 'draft' },
    { id: 'b', opening_code: 'B-0099', schedule_door_mark: null, floor_label: '1', completion_state: null },
    { id: 'd', opening_code: 'B-10', schedule_door_mark: '10', floor_label: '1', completion_state: 'draft' },
  ];
  it('search is loose, sort is natural by floor then mark, and the to-survey filter hides complete openings', () => {
    expect(searchKey('Door 101-A')).toBe('101A');
    expect(filterFacilityOpenings(list, '101-a').map((o) => o.id)).toEqual(['a']);
    expect(filterFacilityOpenings(list, 'b 99').map((o) => o.id)).toEqual(['b']);
    expect(filterFacilityOpenings(list, '', true).map((o) => o.id).sort()).toEqual(['a', 'b', 'd']);
    expect(sortFacilityOpenings(list).map((o) => o.id)).toEqual(['d', 'a', 'b', 'c']);
  });
  it('prefetch saves every opening with bounded concurrency and never throws', async () => {
    let active = 0, peak = 0; const progress: number[] = [];
    const r = await prefetchOpenings(['1', '2', '3', '4', '5'], async (id) => { active++; peak = Math.max(peak, active); await new Promise((ok) => setTimeout(ok, 5)); active--; if (id === '3') throw new Error('x'); }, 2, (d) => progress.push(d));
    expect(r).toEqual({ saved: 4, failed: 1 }); expect(peak).toBe(2); expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(await prefetchOpenings([], async () => {})).toEqual({ saved: 0, failed: 0 });
  });
  it('cache key is per user, organization and building; report link and roles', () => {
    expect(facilityOpeningsCacheKey({ userId: 'u', organizationId: 'o' }, 'b')).toBe('facility-openings:u:o:b');
    expect(comparisonReportHref()).toBe('/dashboard/schedule-comparisons');
    expect(COMPARISON_REPORT_ROLES).toEqual(['admin', 'facilities_manager', 'technician', 'inspector']);
  });
});

describe('M4 v2 imported openings reach technicians in the field app (existing permission model)', () => {
  it('owner-org and assigned-provider technicians list and open imported openings with their hardware; others do not', async () => {
    const { f } = await confirmed();
    const ownerTech = await user(f.owner, 'technician');
    const provider = await org(), providerTech = await user(provider, 'technician');
    const strangerTech = await user(await org(), 'technician');
    const listFor = async (u: any) => (await get(u, `/api/openings?building_id=${f.building}`)).body;
    expect((await listFor(ownerTech)).map((o: any) => o.schedule_door_mark).sort()).toEqual(['101', '102']);
    expect(await listFor(providerTech)).toEqual([]);
    await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [f.property, provider, f.admin.id]);
    const viaProvider = await listFor(providerTech);
    expect(viaProvider.map((o: any) => o.schedule_door_mark).sort()).toEqual(['101', '102']);
    const detail = await get(providerTech, `/api/openings/${viaProvider[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.hardware_components.map((h: any) => h.component_type).sort()).toEqual(['closer', 'hinge', 'lockset']);
    expect(detail.body.door_leaves.length).toBeGreaterThan(0);
    expect(await listFor(strangerTech)).toEqual([]);
    expect((await get(strangerTech, `/api/openings/${viaProvider[0].id}`)).status).toBe(404);
    await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [f.property, provider]);
    expect(await listFor(providerTech)).toEqual([]);
  });
  it('a technician edit to imported hardware is stored and shows in the next comparison', async () => {
    const { f, d } = await confirmed();
    const tech = await user(f.owner, 'technician');
    const o = (await get(tech, `/api/openings?building_id=${f.building}`)).body.find((x: any) => x.schedule_door_mark === '101');
    const hinge = (await get(tech, `/api/openings/${o.id}`)).body.hardware_components.find((h: any) => h.component_type === 'hinge');
    const r = await patch(tech, `/api/hardware/${hinge.id}`, { manufacturer: 'Field Edit Co', condition: 'good', expected_revision: hinge.revision });
    expect(r.status).toBe(200); expect(r.body.manufacturer).toBe('Field Edit Co');
    expect((await patch(tech, `/api/hardware/${hinge.id}`, { manufacturer: 'Stale', expected_revision: hinge.revision })).status).toBe(409);
    const snap = await post(tech, `/api/schedule-comparisons/by-import/${d.id}`);
    expect(snap.status).toBe(201);
    const s = (await get(tech, `/api/schedule-comparisons/${snap.body.id}`)).body;
    const row = s.results.find((x: any) => x.mark === '101');
    expect(row.hardware_set).toMatchObject({ set_key: 'S1', status: 'differs', changed: 1 });
    expect(row.lines.some((l: any) => l.level === 'item' && l.change === 'changed' && l.field_value === 'Field Edit Co')).toBe(true);
    const viewer = await user(f.owner, 'viewer');
    expect((await patch(viewer, `/api/hardware/${hinge.id}`, { manufacturer: 'x', expected_revision: r.body.revision })).status).toBe(403);
  });
  it('comparison report index lists reachable confirmed imports with the latest snapshot (technician entry point)', async () => {
    const { f, d } = await confirmed();
    const tech = await user(f.owner, 'technician'), insp = await user(f.owner, 'inspector'), viewer = await user(f.owner, 'viewer');
    const before = (await get(tech, '/api/schedule-comparisons')).body.imports.find((i: any) => i.import_id === d.id);
    expect(before).toMatchObject({ building_name: 'Synthetic building', property_name: 'Synthetic facility', latest_snapshot_id: null });
    expect(before.property_id).toBeUndefined();
    const s = await post(insp, `/api/schedule-comparisons/by-import/${d.id}`);
    const after = (await get(insp, '/api/schedule-comparisons')).body.imports.find((i: any) => i.import_id === d.id);
    expect(after).toMatchObject({ latest_snapshot_id: s.body.id, latest_engine_version: 2 });
    expect((await get(viewer, '/api/schedule-comparisons')).status).toBe(403);
    const stranger = await user(await org(), 'technician');
    expect((await get(stranger, '/api/schedule-comparisons')).body.imports.some((i: any) => i.import_id === d.id)).toBe(false);
    const draftOnly = await draft(f, [{ mark: '900' }]);
    expect((await get(tech, '/api/schedule-comparisons')).body.imports.some((i: any) => i.import_id === draftOnly.id)).toBe(false);
  });
});