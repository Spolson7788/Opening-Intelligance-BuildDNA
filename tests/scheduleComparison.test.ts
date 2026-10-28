import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ db: null as any }));
// M4: schedule vs field comparison snapshots. In-process disposable SQL only; synthetic data only.
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/storage', () => ({ getPresignedUploadUrl: async (key: string) => 'https://storage.invalid/' + key }));
import { scheduleImportsRouter } from '../src/routes/scheduleImports';
import { scheduleComparisonsRouter } from '../src/routes/scheduleComparisons';
import { csvCell, comparisonCsv, CSV_COLUMNS, effectiveSet } from '../src/services/scheduleComparison';
const app = express(); app.use(express.json());
app.use('/api/schedule-imports', scheduleImportsRouter); app.use('/api/schedule-comparisons', scheduleComparisonsRouter);
const migration = '20261028150000_schedule_comparison_snapshots.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
let rollbackProven = false, undoProven = false;
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const exists = async () => (await sql("SELECT to_regclass('public.schedule_comparison_snapshots') AS n")).rows[0].n !== null;
beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < migration).sort()) await state.db.exec(fix(readFileSync('migrations/' + name, 'utf8')));
  await state.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT PRIMARY KEY)');
  const script = readFileSync('migrations/' + migration, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;');
  rollbackProven = !(await exists());
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  await state.db.exec(readFileSync('docs/rollback/20261028150000_schedule_comparison_snapshots_rollback.sql', 'utf8'));
  undoProven = !(await exists()) && (await sql("SELECT count(*)::int AS c FROM pg_proc WHERE proname LIKE 'schedule_comparison_snapshots_%'")).rows[0].c === 0;
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
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
const opening = async (building: string, mark: string) => (await sql('SELECT * FROM openings WHERE building_id=$1 AND schedule_door_mark=$2', [building, mark])).rows[0];
const hw = async (oid: string, type: string) => (await sql('SELECT * FROM hardware_components WHERE opening_id=$1 AND component_type=$2', [oid, type])).rows[0];
const tick = () => new Promise(r => setTimeout(r, 30));

let F: any, imp: any;
/** Confirmed synthetic import, then simulated field work covering every category. */
async function scenario() {
  F = await facility();
  imp = await draft(F, [
    { mark: '101', fire: 90 },
    { mark: '102', config: 'pair', w: 72, door: 'WD' },
    { mark: '103' },
    { mark: '107' },
    { mark: 'D104', set: null },
    { mark: '106' },
  ]);
  const c = await post(F.admin, `/api/schedule-imports/${imp.id}/confirm`, { resolutions: { rows: { [imp.rows[3]]: { skip: true } } } });
  expect(c.status).toBe(200);
  // 101: verified opening + leaf, fire rating and height differ; width 35.9 is inside the 1/8" tolerance.
  const o101 = await opening(F.building, '101');
  await sql("UPDATE openings SET completion_state='complete', completed_at=now(), completed_by_user_id=$2, fire_rated=false WHERE id=$1", [o101.id, F.admin.id]);
  await sql("UPDATE door_leaves SET condition='good', height_in=80, width_in=35.9 WHERE opening_id=$1", [o101.id]);
  await sql("UPDATE hardware_components SET review_state='reviewed', manufacturer='=Stanley' WHERE id=$1", [(await hw(o101.id, 'hinge')).id]);
  await sql("UPDATE hardware_components SET lifecycle_state='retired' WHERE id=$1", [(await hw(o101.id, 'lockset')).id]);
  await sql("UPDATE hardware_components SET condition='failed' WHERE id=$1", [(await hw(o101.id, 'closer')).id]);
  await sql(`INSERT INTO hardware_components(id,opening_id,component_type,manufacturer,model_number,tracker_id,mounting_scope,position_label,condition,identity_status,review_state)
    VALUES($1,$2,'exit_device','Von Duprin','99','TRK-SYN0001','opening','Synthetic field exit device','good','established','reviewed')`, [randomUUID(), o101.id]);
  // 102: pair verified; leaf width 36 = schedule 72 / 2, so it matches.
  const o102 = await opening(F.building, '102');
  await sql("UPDATE openings SET completion_state='complete', completed_at=now(), completed_by_user_id=$2 WHERE id=$1", [o102.id, F.admin.id]);
  await sql("UPDATE door_leaves SET condition='good' WHERE opening_id=$1", [o102.id]);
  // D104: legacy field opening without a schedule mark whose code normalizes to the mark; surveyed by photo.
  const o104 = await opening(F.building, 'D104');
  await sql("UPDATE openings SET schedule_door_mark=NULL, opening_code=' d104. ' WHERE id=$1", [o104.id]);
  await sql("INSERT INTO photos(id,opening_id,storage_url) VALUES($1,$2,'https://storage.invalid/synthetic.jpg')", [randomUUID(), o104.id]);
  // 106: decommissioned since the import.
  await sql("UPDATE openings SET status='decommissioned' WHERE schedule_door_mark='106' AND building_id=$1", [F.building]);
  // Field-only opening, not in the schedule.
  const fid = randomUUID();
  await sql("INSERT INTO openings(id,opening_code,building_id,opening_type,fire_rated,qr_token,status,completion_state) VALUES($1,'FIELD-9',$2,'door',false,$3,'active','complete')", [fid, F.building, randomUUID()]);
  return { o101, o102, o104 };
}

describe('M4 schedule vs field comparison snapshots', () => {
  it('migration is additive, rolls back in a transaction, and the undo script removes it', () => {
    expect(rollbackProven).toBe(true); expect(undoProven).toBe(true);
  });
  it('effective hardware set follows the stored resolutions', () => {
    const keys = new Set(['1-INT', 'S1']);
    expect(effectiveSet({ id: 'r', hw_set_key: '1' }, { set_map: { '1': '1-INT' } }, keys)).toBe('1-INT');
    expect(effectiveSet({ id: 'r', hw_set_key: '1' }, { set_map: { '1': '1-INT' }, row_sets: { r: null } }, keys)).toBe(null);
    expect(effectiveSet({ id: 'r', hw_set_key: 'S1' }, {}, keys)).toBe('S1');
    expect(effectiveSet({ id: 'r', hw_set_key: 'X' }, {}, keys)).toBe(null);
  });
  it('run comparison stores a snapshot with all six categories', async () => {
    await scenario();
    const r = await post(F.admin, `/api/schedule-comparisons/by-import/${imp.id}`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ import_id: imp.id, engine_version: 1, created_by_role: 'admin', created_by_name: 'Synthetic user', opening_count: 7 });
    expect(r.body.summary).toMatchObject({ schedule_rows: 6, live_openings: 6, matched_by_code: 1, surveyed: 3, openings_matched: 2, openings_with_differences: 1,
      scheduled_not_surveyed: 1, scheduled_opening_missing: 2, not_in_schedule: 1, field_mismatch: 2, hardware_difference: 4, open_follow_up: 1 });
    const s = (await get(F.admin, `/api/schedule-comparisons/${r.body.id}`)).body;
    const by = (m: string) => s.results.find((o: any) => o.mark === m || o.opening_code === m);
    expect(by('101').status).toBe('differences');
    expect(by('101').lines.filter((l: any) => l.category === 'field_mismatch').map((l: any) => [l.entity, l.field, l.schedule_value, l.field_value]))
      .toEqual([['opening', 'fire_rated', 'yes', 'no'], ['door_leaf', 'single.height_in', '84', '80']]);
    expect(by('101').lines.filter((l: any) => l.category === 'hardware_difference').map((l: any) => l.note).sort())
      .toEqual(['field hardware not in schedule', 'scheduled item not found in field', 'verified failed: needs replacement', null].sort());
    expect(by('102')).toMatchObject({ status: 'matched', surveyed: true, match: 'mark' });
    expect(by('103')).toMatchObject({ status: 'not_surveyed', surveyed: false });
    expect(by('D104')).toMatchObject({ status: 'matched', match: 'code', surveyed: true });
    expect(by('D104').lines.map((l: any) => [l.category, l.note])).toEqual([['open_follow_up', 'hw_missing']]);
    expect(s.results.filter((o: any) => o.status === 'missing').map((o: any) => o.lines[0].note).sort()).toEqual(['decommissioned', 'skipped_by_user']);
    expect(by('FIELD-9')).toMatchObject({ status: 'not_in_schedule', surveyed: true });
    await tick();
    expect((await sql('SELECT action FROM audit_log WHERE path=$1', [`/api/schedule-comparisons/by-import/${imp.id}`])).rows.map((a: any) => a.action)).toEqual(['Ran schedule comparison']);
  });
  it('CSV comes from the snapshot, with formula guard and quoting', async () => {
    const list = (await get(F.admin, `/api/schedule-comparisons/by-import/${imp.id}`)).body;
    const r = await get(F.admin, `/api/schedule-comparisons/${list.snapshots[0].id}/csv`);
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="schedule-comparison-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv"/);
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines.length - 1).toBe(list.snapshots[0].line_count);
    expect(r.text).toContain(",'=Stanley,");
    expect(r.text).toContain('matched by code');
    expect(csvCell('=1+1')).toBe("'=1+1"); expect(csvCell('+x')).toBe("'+x"); expect(csvCell('-x')).toBe("'-x"); expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('a,"b"')).toBe('"a,""b"""'); expect(csvCell(null)).toBe('');
    expect(comparisonCsv('i', 'B', { openings: [] })).toBe(CSV_COLUMNS.join(',') + '\r\n');
  });
  it('snapshots are frozen: later field work only shows in a new snapshot; rows cannot change', async () => {
    const before = (await get(F.admin, `/api/schedule-comparisons/by-import/${imp.id}`)).body.snapshots[0];
    const o103 = await opening(F.building, '103');
    await sql("UPDATE door_leaves SET condition='good', thickness_in=2 WHERE opening_id=$1", [o103.id]);
    const again = await post(F.admin, `/api/schedule-comparisons/by-import/${imp.id}`);
    expect(again.body.summary.field_mismatch).toBe(3); expect(again.body.summary.scheduled_not_surveyed).toBe(0);
    const old = (await get(F.admin, `/api/schedule-comparisons/${before.id}`)).body;
    expect(old.summary.field_mismatch).toBe(2);
    const listed = (await get(F.admin, `/api/schedule-comparisons/by-import/${imp.id}`)).body.snapshots.map((s: any) => s.id);
    expect(listed).toEqual([again.body.id, before.id]);
    await expect(sql("UPDATE schedule_comparison_snapshots SET summary='{}'::jsonb WHERE id=$1", [before.id])).rejects.toThrow(/read-only/);
    await expect(sql('DELETE FROM schedule_comparison_snapshots WHERE id=$1', [before.id])).rejects.toThrow(/read-only/);
  });
  it('technicians and inspectors can run, view and export; viewers cannot; other orgs get 404', async () => {
    const tech = await user(F.owner, 'technician'), insp = await user(F.owner, 'inspector'), viewer = await user(F.owner, 'viewer');
    const t = await post(tech, `/api/schedule-comparisons/by-import/${imp.id}`);
    expect(t.status).toBe(201); expect(t.body.created_by_role).toBe('technician');
    expect((await get(insp, `/api/schedule-comparisons/by-import/${imp.id}`)).status).toBe(200);
    expect((await get(insp, `/api/schedule-comparisons/${t.body.id}`)).status).toBe(200);
    expect((await get(tech, `/api/schedule-comparisons/${t.body.id}/csv`)).status).toBe(200);
    expect((await post(viewer, `/api/schedule-comparisons/by-import/${imp.id}`)).status).toBe(403);
    expect((await get(viewer, `/api/schedule-comparisons/${t.body.id}/csv`)).status).toBe(403);
    const stranger = await user(await org(), 'admin');
    expect((await post(stranger, `/api/schedule-comparisons/by-import/${imp.id}`)).status).toBe(404);
    expect((await get(stranger, `/api/schedule-comparisons/${t.body.id}`)).status).toBe(404);
    expect((await get(stranger, `/api/schedule-comparisons/${t.body.id}/csv`)).status).toBe(404);
    expect((await get(F.admin, '/api/schedule-comparisons/not-a-uuid')).status).toBe(404);
  });
  it('draft imports cannot be compared (API 409, database refuses too)', async () => {
    const f = await facility(); const d = await draft(f, [{ mark: '1' }]);
    expect((await post(f.admin, `/api/schedule-comparisons/by-import/${d.id}`)).body).toEqual({ error: 'import_not_confirmed' });
    await expect(sql(`INSERT INTO schedule_comparison_snapshots(id,import_id,property_id,building_id,engine_version,summary,results,opening_count,line_count,created_by_user_id,created_by_organization_id,created_by_role)
      VALUES($1,$2,$3,$4,1,'{}','[]',0,0,$5,$6,'admin')`, [randomUUID(), d.id, f.property, f.building, f.admin.id, f.owner])).rejects.toThrow(/confirmed import/);
    expect((await sql('SELECT count(*)::int AS c FROM schedule_comparison_snapshots WHERE import_id=$1', [d.id])).rows[0].c).toBe(0);
  });
  it('running a comparison changes no field or schedule data', async () => {
    const tables = ['openings', 'door_leaves', 'opening_frames', 'hardware_components', 'schedule_rows', 'schedule_import_effects', 'schedule_row_follow_ups', 'schedule_imports'];
    const snap = async () => Promise.all(tables.map(async (t) => (await sql(`SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0].h));
    const a = await snap();
    expect((await post(F.admin, `/api/schedule-comparisons/by-import/${imp.id}`)).status).toBe(201);
    expect(await snap()).toEqual(a);
  });
});