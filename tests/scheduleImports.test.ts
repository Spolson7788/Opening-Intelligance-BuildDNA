import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { doorScheduleXlsx, hardwareDocx } from './fixtures/scheduleFixtures';
const state = vi.hoisted(() => ({ db: null as any, files: new Map<string, Uint8Array>() }));
// In-process disposable SQL; stored files come from a mocked reader (no bucket).
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/storage', () => ({ getPresignedUploadUrl: async () => 'https://storage.invalid/x', getObjectBytes: async () => { throw new Error('no storage offline'); } }));
vi.mock('../src/services/scheduleFileReader', () => ({
  readScheduleFile: async (key: string) => { const f = state.files.get(key); if (!f) throw new Error('missing'); return f; },
}));
import { scheduleImportsRouter } from '../src/routes/scheduleImports';
const app = express(); app.use(express.json()); app.use('/api/schedule-imports', scheduleImportsRouter);
const migration = '20261027130000_schedule_imports.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
let rollbackProven = false;
beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < migration).sort()) {
    await state.db.exec(readFileSync('migrations/' + name, 'utf8')
      .replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()'));
  }
  const script = readFileSync('migrations/' + migration, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;');
  rollbackProven = (await sql("SELECT to_regclass('public.schedule_imports') AS t, (SELECT count(*) FROM information_schema.columns WHERE table_name='openings' AND column_name='schedule_door_mark')::int AS c")).rows
    .every((r: any) => r.t === null && r.c === 0);
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
}, 120000);
afterAll(async () => { await state.db?.close(); });

async function org() { const id = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic org','customer')", [id]); return id; }
async function user(orgId: string, role = 'admin') {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user',$4,'not-a-real-password')", [id, orgId, id + '@example.invalid', role]);
  return { id, org: orgId, token: jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function version(property: string, u: any, kind: 'door' | 'hardware', type: string, bytes: Uint8Array) {
  const schedule = randomUUID(), id = randomUUID(), key = `facility-schedules/${property}/${id}.bin`;
  await sql("INSERT INTO facility_schedules(id,property_id,created_by_organization_id,created_by_user_id,kind,title,head_version) VALUES($1,$2,$3,$4,$5,'Synthetic',1)", [schedule, property, u.org, u.id, kind]);
  await sql(`INSERT INTO facility_schedule_versions(id,schedule_id,version,storage_key,original_filename,content_type,byte_size,sha256,uploaded_by_user_id,uploaded_by_organization_id)
    VALUES($1,$2,1,$3,'synthetic',$4,$5,$6,$7,$8)`, [id, schedule, key, type, bytes.byteLength, 'c'.repeat(64), u.id, u.org]);
  state.files.set(key, bytes);
  return id;
}
async function facility() {
  const owner = await org(), admin = await user(owner), portfolio = randomUUID(), property = randomUUID(), building = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio, owner]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [property, portfolio]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Building A')", [building, property]);
  const door = await version(property, admin, 'door', XLSX, doorScheduleXlsx());
  const hw = await version(property, admin, 'hardware', DOCX, hardwareDocx());
  return { owner, admin, property, building, door, hw };
}
const auth = (u: any) => ({ Authorization: 'Bearer ' + u.token });
const create = (u: any, body: any) => request(app).post('/api/schedule-imports').set(auth(u)).send(body);
const get = (u: any, id: string) => request(app).get('/api/schedule-imports/' + id).set(auth(u));
const confirm = (u: any, id: string, resolutions: any = {}) => request(app).post(`/api/schedule-imports/${id}/confirm`).set(auth(u)).send({ resolutions });
async function newImport(f: any, u = f.admin, building = f.building) {
  const r = await create(u, { building_id: building, door_version_id: f.door, hardware_version_id: f.hw });
  expect(r.status).toBe(201); return r.body.id as string;
}
/** Resolve every sample problem the way a user would in the UI. */
function resolveAll(preview: any) {
  const rows: Record<string, any> = {};
  for (const i of preview.plan.issues.filter((x: any) => x.code === 'duplicate_mark')) {
    i.row_ids.slice(1).forEach((id: string, n: number) => { rows[id] = { mark: `${i.key}-${String.fromCharCode(66 + n)}` }; });
  }
  return { rows, set_map: { '1': '1-EXT', X: null, '23': null } };
}
const count = async (t: string, where = 'true', args: unknown[] = []) => (await sql(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`, args)).rows[0].n;

describe('schedule imports M2', () => {
  it('migration is additive and rolls back cleanly', () => { expect(rollbackProven).toBe(true); });

  it('preview reports every sample problem', async () => {
    const f = await facility();
    const id = await newImport(f);
    const p = await get(f.admin, id);
    expect(p.status).toBe(200);
    const codes = (c: string) => p.body.plan.issues.filter((i: any) => i.code === c);
    expect(codes('duplicate_mark').map((i: any) => i.key).sort()).toEqual(['150', '151', '152']);
    expect(codes('duplicate_mark').every((i: any) => i.severity === 'blocker')).toBe(true);
    expect(codes('unknown_group').map((i: any) => i.key).sort()).toEqual(['23', 'X']);
    expect(codes('ambiguous_group')[0]).toMatchObject({ key: '1' });
    expect(codes('ambiguous_group')[0].message).toContain('1-EXT, 1-GAR, 1-INT');
    expect(codes('hw_varies')).toHaveLength(1);
    expect(codes('missing_set_numbers')[0].message).toMatch(/\b23\b/);
    expect(codes('unmatched_items')[0].item_ids).toHaveLength(1);
    expect(codes('type_template_rows')[0].row_ids).toHaveLength(2);
    expect(codes('furnished_by_others')[0].message).toContain('11');
    expect(codes('column_shift')).toHaveLength(1);
    expect(p.body.plan.blocked).toBe(true);
    expect(p.body.plan.summary).toMatchObject({ door_rows: 12, create_openings: 6, skipped_rows: 6 });
  });

  it('confirm refuses unresolved blockers and writes nothing', async () => {
    const f = await facility();
    const id = await newImport(f);
    const r = await confirm(f.admin, id);
    expect(r.status).toBe(409);
    expect(await count('openings', 'building_id=$1', [f.building])).toBe(0);
    expect((await sql('SELECT status FROM schedule_imports WHERE id=$1', [id])).rows[0].status).toBe('draft');
  });

  it('confirm applies resolutions transactionally and is idempotent', async () => {
    const f = await facility();
    const id = await newImport(f);
    const res = resolveAll((await get(f.admin, id)).body);
    const preview = await request(app).post(`/api/schedule-imports/${id}/preview`).set(auth(f.admin)).send({ resolutions: res });
    expect(preview.body.plan.blocked).toBe(false);
    expect(preview.body.plan.summary.create_openings).toBe(12);
    const first = await confirm(f.admin, id, res);
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ openings_created: 12 });
    const opening = (m: string) => sql('SELECT * FROM openings WHERE building_id=$1 AND schedule_door_mark=$2', [f.building, m]).then((x: any) => x.rows[0]);
    const o101 = await opening('101');
    expect(o101).toMatchObject({ status: 'pending_capture', opening_type: 'door', opening_configuration: 'single', fire_rated: false });
    const leaf = (await sql('SELECT * FROM door_leaves WHERE opening_id=$1', [o101.id])).rows;
    expect(leaf.map((l: any) => [l.leaf_role, Number(l.width_in), Number(l.height_in), Number(l.thickness_in), l.material])).toEqual([['single', 36, 84, 1.75, 'HOLLOW METAL INSULATED CORE']]);
    const hw101 = (await sql('SELECT component_type, manufacturer, model_number, finish FROM hardware_components WHERE opening_id=$1 ORDER BY position_label', [o101.id])).rows;
    expect(hw101).toEqual(expect.arrayContaining([{ component_type: 'exit_device', manufacturer: 'Cal-Royal', model_number: 'AF7700EO', finish: 'US10B' },
      { component_type: 'electric_strike', manufacturer: 'Adams Rite', model_number: '4300', finish: '313' }]));
    expect(hw101).toHaveLength(5);
    const pair = await opening('S301');
    expect(pair).toMatchObject({ opening_configuration: 'pair', fire_rated: true });
    expect((await sql('SELECT leaf_role, width_in FROM door_leaves WHERE opening_id=$1 ORDER BY leaf_role', [pair.id])).rows.map((l: any) => [l.leaf_role, Number(l.width_in)])).toEqual([['active', 36], ['inactive', 36]]);
    expect(await count('hardware_components', 'opening_id=$1', [(await opening('E1')).id])).toBe(2); // mapped 1 -> 1-EXT
    expect(await count('hardware_components', 'opening_id=$1', [(await opening('150')).id])).toBe(0); // Group X -> none
    expect(await count('hardware_components', 'opening_id=$1', [(await opening('150-B')).id])).toBe(4); // Group 3 minus Flux Capacitor (review)
    expect(await count('hardware_components', "model_number LIKE 'FC-88%'")).toBe(0);
    const before = { o: await count('openings'), h: await count('hardware_components'), e: await count('schedule_import_effects', 'import_id=$1', [id]) };
    const again = await confirm(f.admin, id, res);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ already_confirmed: true, result: first.body.result });
    expect({ o: await count('openings'), h: await count('hardware_components'), e: await count('schedule_import_effects', 'import_id=$1', [id]) }).toEqual(before);
    // A fresh import of the same files is a no-op.
    const id2 = await newImport(f);
    const p2 = await request(app).post(`/api/schedule-imports/${id2}/preview`).set(auth(f.admin)).send({ resolutions: resolveAll((await get(f.admin, id2)).body) });
    expect(p2.body.plan.summary).toMatchObject({ create_openings: 0, update_openings: 0, unchanged_openings: 12, add_hardware: 0 });
    const c2 = await confirm(f.admin, id2, resolveAll((await get(f.admin, id2)).body));
    expect(c2.body.result).toMatchObject({ openings_created: 0, hardware_added: 0, fields_written: 0 });
    expect({ o: await count('openings'), h: await count('hardware_components') }).toEqual({ o: before.o, h: before.h });
  });

  it('accepting a flagged item applies it', async () => {
    const f = await facility();
    const id = await newImport(f);
    const p = (await get(f.admin, id)).body;
    const res = { ...resolveAll(p), accept_items: p.plan.issues.find((i: any) => i.code === 'unmatched_items').item_ids };
    expect((await confirm(f.admin, id, res)).status).toBe(200);
    expect(await count('hardware_components', "model_number='FC-88' AND component_type='other'")).toBeGreaterThan(0);
  });

  it('never overwrites field-verified values without per-field confirmation, never deletes', async () => {
    const f = await facility();
    const o = randomUUID(), leaf = randomUUID(), hw = randomUUID();
    await sql(`INSERT INTO openings(id,opening_code,building_id,location_description,opening_type,qr_token,status,completion_state,completed_at)
      VALUES($1,'101',$2,'Field-verified lobby door','door',$3,'active','complete',now())`, [o, f.building, randomUUID()]).catch(async () => {
      await sql(`INSERT INTO openings(id,opening_code,building_id,location_description,opening_type,qr_token,status) VALUES($1,'101',$2,'Field-verified lobby door','door',$3,'active')`, [o, f.building, randomUUID()]);
      await sql("UPDATE openings SET completion_state='complete', completed_at=now() WHERE id=$1", [o]);
    });
    await sql("INSERT INTO door_leaves(id,opening_id,leaf_role,material,width_in,condition) VALUES($1,$2,'single','WOOD',40,'good')", [leaf, o]);
    await sql("INSERT INTO hardware_components(id,opening_id,component_type,manufacturer,tracker_id,condition,review_state,identity_status) VALUES($1,$2,'exit_device','FieldCo','TRK-FIELD001','good','reviewed','established')", [hw, o]);
    const id = await newImport(f);
    const res = resolveAll((await get(f.admin, id)).body);
    const p = (await request(app).post(`/api/schedule-imports/${id}/preview`).set(auth(f.admin)).send({ resolutions: res })).body.plan;
    const row = p.openings.find((x: any) => x.mark === '101');
    expect(row).toMatchObject({ action: 'update', opening_id: o });
    const st = (field: string) => row.fields.find((x: any) => x.field === field);
    expect(st('location_description')).toMatchObject({ status: 'protected', overwrite_key: `opening:${o}:location_description` });
    expect(st('width_in')).toMatchObject({ status: 'protected', from: expect.anything(), to: 36 });
    expect(st('material')).toMatchObject({ status: 'protected' });
    expect(st('thickness_in')).toMatchObject({ status: 'fill' });
    expect(row.hardware.find((h: any) => h.component_type === 'exit_device')).toMatchObject({ action: 'field_present', component_id: hw });
    // Explicitly overwrite only the leaf width.
    const c = await confirm(f.admin, id, { ...res, overwrite: [`door_leaf:${leaf}:width_in`] });
    expect(c.status).toBe(200);
    const after = (await sql('SELECT o.location_description, o.schedule_door_mark, l.width_in, l.material, l.thickness_in FROM openings o JOIN door_leaves l ON l.opening_id=o.id WHERE o.id=$1', [o])).rows[0];
    expect(after.location_description).toBe('Field-verified lobby door');
    expect(after.material).toBe('WOOD');
    expect(Number(after.width_in)).toBe(36);
    expect(Number(after.thickness_in)).toBe(1.75);
    expect(after.schedule_door_mark).toBe('101');
    expect((await sql('SELECT manufacturer, lifecycle_state FROM hardware_components WHERE id=$1', [hw])).rows[0]).toEqual({ manufacturer: 'FieldCo', lifecycle_state: 'active' });
    expect(await count('hardware_components', "opening_id=$1 AND component_type='exit_device'", [o])).toBe(1);
    expect(await count('schedule_import_effects', "import_id=$1 AND entity_type='door_leaf' AND field='width_in'", [id])).toBe(1);
  });

  it('enforces roles, org isolation and provider assignment', async () => {
    const f = await facility();
    for (const role of ['technician', 'inspector', 'viewer']) {
      const u = await user(f.owner, role);
      expect((await create(u, { building_id: f.building, door_version_id: f.door })).status).toBe(403);
    }
    const fm = await user(f.owner, 'facilities_manager');
    const id = await newImport(f, fm);
    const other = await org(), stranger = await user(other);
    expect((await create(stranger, { building_id: f.building, door_version_id: f.door })).status).toBe(404);
    expect((await get(stranger, id)).status).toBe(404);
    expect((await confirm(stranger, id)).status).toBe(404);
    const viewer = await user(f.owner, 'viewer');
    expect((await get(viewer, id)).status).toBe(403);
    expect((await confirm(viewer, id)).status).toBe(403);
    const provider = await org(), pfm = await user(provider, 'facilities_manager');
    await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [f.property, provider, f.admin.id]);
    expect((await get(pfm, id)).status).toBe(200);
    expect((await create(pfm, { building_id: f.building, door_version_id: f.door })).status).toBe(201);
    await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [f.property, provider]);
    expect((await get(pfm, id)).status).toBe(404);
    // A building from another facility is rejected, and versions must match their kind.
    const g = await facility();
    expect((await create(f.admin, { building_id: g.building, door_version_id: f.door })).status).toBe(404);
    expect((await create(f.admin, { building_id: f.building, door_version_id: f.hw })).status).toBe(400);
    expect((await create(f.admin, { building_id: f.building, door_version_id: f.door, hardware_version_id: g.hw })).status).toBe(404);
    const list = await request(app).get('/api/schedule-imports/by-property/' + f.property).set(auth(f.admin));
    expect(list.body.length).toBe(2);
  });

  it('PDF schedules are stored but not parsed', async () => {
    const f = await facility();
    const pdf = await version(f.property, f.admin, 'door', 'application/pdf', new Uint8Array([37, 80, 68, 70]));
    const r = await create(f.admin, { building_id: f.building, door_version_id: pdf });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('door_schedule_format_not_parsed');
    expect(await count('schedule_imports', 'property_id=$1', [f.property])).toBe(0);
  });

  it('import source rows and confirmed imports are immutable', async () => {
    const f = await facility();
    const id = await newImport(f);
    await expect(sql('DELETE FROM schedule_rows WHERE import_id=$1', [id])).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM schedule_imports WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
    await confirm(f.admin, id, resolveAll((await get(f.admin, id)).body));
    await expect(sql("UPDATE schedule_imports SET result='{}' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
  });
});
