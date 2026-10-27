import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildXlsx, doorScheduleRows, hardwareDocx } from './fixtures/scheduleFixtures';
import { confirmErrorMessage } from '../dashboard/src/pages/ScheduleImportPage';
import { ApiError } from '../dashboard/src/lib/api';
// M2E: a full, sample-sized confirm (~150 schedule rows) must finish in a small, fixed number of
// statements so it fits inside the hosted function timeout. Every statement on the confirm's
// transaction client is counted.
const state = vi.hoisted(() => ({ db: null as any, files: new Map<string, Uint8Array>(), log: [] as string[] }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => { state.log.push(s); return state.db.query(s, a); }, release: () => {} }),
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

/** The synthetic fixture plus 138 extra doors: 150 data rows, mixing hardware groups and blank hardware. */
function bigDoorSchedule() {
  const d = doorScheduleRows();
  const at = d.rows.findIndex(r => r[1] === 160) + 1;
  const extra = Array.from({ length: 138 }, (_, i) => {
    const hw = i % 3 === 0 ? 'Group 2' : i % 3 === 1 ? 'Group 3' : '';
    return [`ROOM-${400 + i}`, 400 + i, 'A1', `3' - 0"`, `7' - 0"`, `0' - 1 3/4"`, 'SINGLE', 'HOLLOW METAL INSULATED CORE', null, hw, 'Closer', i % 2 ? '20 MIN' : '0 MIN', null, 'CORRIDOR'];
  });
  d.rows.splice(at, 0, ...extra);
  // merges after the insertion point move down by the inserted row count
  const merges = d.merges.map(m => m.replace(/([A-Z])(\d+)/g, (_s, c, n) => c + (Number(n) > at ? Number(n) + extra.length : n)));
  return buildXlsx(d.rows, merges);
}

describe('schedule import confirm batching (M2E)', () => {
  it('confirms a sample-sized import in a small number of statements with correct results', async () => {
    const org = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic org','customer')", [org]);
    const uid = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user','admin','not-a-real-password')", [uid, org, uid + '@example.invalid']);
    const auth = { Authorization: 'Bearer ' + jwt.sign({ userId: uid, organizationId: org, role: 'admin', sessionVersion: 0 }, process.env.JWT_SECRET!) };
    const portfolio = randomUUID(), property = randomUUID(), building = randomUUID();
    await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'P')", [portfolio, org]);
    await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'F')", [property, portfolio]);
    await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Building A')", [building, property]);
    const version = async (kind: string, type: string, bytes: Uint8Array) => {
      const schedule = randomUUID(), id = randomUUID(), key = `facility-schedules/${property}/${id}.bin`;
      await sql("INSERT INTO facility_schedules(id,property_id,created_by_organization_id,created_by_user_id,kind,title,head_version) VALUES($1,$2,$3,$4,$5,'Synthetic',1)", [schedule, property, org, uid, kind]);
      await sql(`INSERT INTO facility_schedule_versions(id,schedule_id,version,storage_key,original_filename,content_type,byte_size,sha256,uploaded_by_user_id,uploaded_by_organization_id)
        VALUES($1,$2,1,$3,'synthetic',$4,$5,$6,$7,$8)`, [id, schedule, key, type, bytes.byteLength, 'c'.repeat(64), uid, org]);
      state.files.set(key, bytes); return id;
    };
    // An existing opening whose code collides with the first new door's base code (bulk reservation must skip it).
    const tag = building.replace(/-/g, '').slice(0, 6).toUpperCase();
    await sql("INSERT INTO openings(id,opening_code,building_id,opening_type,qr_token,status) VALUES($1,$2,$3,'door',$4,'pending_capture')", [randomUUID(), `400-${tag}`, building, randomUUID()]);
    const door = await version('door', XLSX, bigDoorSchedule()), hw = await version('hardware', DOCX, hardwareDocx());
    const created = await request(app).post('/api/schedule-imports').set(auth).send({ building_id: building, door_version_id: door, hardware_version_id: hw });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const preview = (await request(app).get('/api/schedule-imports/' + id).set(auth)).body;
    const rows: Record<string, any> = {};
    for (const i of preview.plan.issues.filter((x: any) => x.code === 'duplicate_mark')) i.row_ids.slice(1).forEach((r: string, n: number) => { rows[r] = { mark: `${i.key}-${String.fromCharCode(66 + n)}` }; });
    const resolutions = { rows, set_map: { '1': '1-EXT', X: null, '23': null } };
    const expected = (await request(app).post(`/api/schedule-imports/${id}/preview`).set(auth).send({ resolutions })).body.plan.summary;
    state.log.length = 0;
    const res = await request(app).post(`/api/schedule-imports/${id}/confirm`).set(auth).send({ resolutions });
    expect(res.status).toBe(200);
    const statements = state.log.length;
    console.log(`[M2E] confirm statements: ${statements}; result ${JSON.stringify(res.body.result)}`);
    expect(statements).toBeGreaterThanOrEqual(10);
    expect(statements).toBeLessThanOrEqual(25);
    const r = res.body.result;
    expect(r.openings_created).toBe(expected.create_openings ?? r.openings_created);
    expect(r.openings_created).toBeGreaterThanOrEqual(140);
    const n = async (q: string) => (await sql(q, [building])).rows[0].n as number;
    expect(await n('SELECT count(*)::int n FROM openings WHERE building_id=$1')).toBe(r.openings_created + 1);
    expect(await n('SELECT count(*)::int n FROM door_leaves l JOIN openings o ON o.id=l.opening_id WHERE o.building_id=$1')).toBe(r.leaves_created);
    expect(await n('SELECT count(*)::int n FROM opening_frames f JOIN openings o ON o.id=f.opening_id WHERE o.building_id=$1')).toBe(r.frames_created);
    expect(await n('SELECT count(*)::int n FROM hardware_components h JOIN openings o ON o.id=h.opening_id WHERE o.building_id=$1')).toBe(r.hardware_added);
    expect(r.hardware_added).toBeGreaterThan(200);
    expect((await sql('SELECT count(*)::int n FROM schedule_row_follow_ups WHERE import_id=$1', [id])).rows[0].n).toBe(r.follow_ups);
    expect(r.follow_ups).toBeGreaterThanOrEqual(46); // blank hardware rows get hw_missing follow-ups
    expect((await sql("SELECT count(*)::int n FROM schedule_row_follow_ups WHERE import_id=$1 AND reason='hw_missing'", [id])).rows[0].n).toBeGreaterThanOrEqual(46);
    const eff = (await sql("SELECT count(*)::int n, count(*) FILTER (WHERE old_value IS NOT NULL AND jsonb_typeof(old_value)='null')::int nulls FROM schedule_import_effects WHERE import_id=$1", [id])).rows[0];
    expect(eff.n).toBe(r.openings_created + r.leaves_created + r.frames_created + r.hardware_added + r.fields_written);
    expect(eff.nulls).toBe(eff.n); // creates keep JSON null old_value exactly as before
    // codes are unique, the colliding base was skipped, and the opening carries its schedule mark
    expect(await n('SELECT count(DISTINCT opening_code)::int n FROM openings WHERE building_id=$1')).toBe(r.openings_created + 1);
    expect((await sql("SELECT opening_code FROM openings WHERE building_id=$1 AND schedule_door_mark='400'", [building])).rows[0].opening_code).toBe(`400-${tag}-2`);
    const one = (await sql("SELECT o.fire_rated, o.status, l.width_in, l.condition FROM openings o JOIN door_leaves l ON l.opening_id=o.id WHERE o.building_id=$1 AND o.schedule_door_mark='401'", [building])).rows[0];
    expect(one).toMatchObject({ status: 'pending_capture', condition: 'unverified' });
    expect(Number(one.width_in)).toBe(36);
    expect((await sql('SELECT status FROM schedule_imports WHERE id=$1', [id])).rows[0].status).toBe('confirmed');
    // idempotent: confirming again changes nothing
    const again = await request(app).post(`/api/schedule-imports/${id}/confirm`).set(auth).send({ resolutions });
    expect(again.body.already_confirmed).toBe(true);
  }, 180000);

  it('shows a distinct message for gateway timeouts', () => {
    expect(confirmErrorMessage(new ApiError(504, 'request_failed_504'))).toBe('Import timed out. Nothing was changed. Try again.');
    expect(confirmErrorMessage(new ApiError(502, 'request_failed_502'))).toBe('Import timed out. Nothing was changed. Try again.');
    expect(confirmErrorMessage(new ApiError(409, 'unresolved_blockers'))).toBe('Resolve the blocking issues first.');
    expect(confirmErrorMessage(new ApiError(500, 'confirm_failed'))).toBe('Confirm failed. Nothing was changed.');
  });
});