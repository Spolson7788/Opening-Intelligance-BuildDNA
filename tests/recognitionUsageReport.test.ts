import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// OI-staff-only recognition usage report (Oct 29 11:17 decision): $0.75 per opening per month billed
// to BOTH the provider and the facility; shared openings count once for cost; photos/runs/cost per
// company and month; 80%-of-safety-cap warning. Full app, every migration (incl. DRAFT 090800),
// disposable PGlite, mocked storage + provider (no paid call), synthetic data only.
const state = vi.hoisted(() => ({ db: null as any, objects: new Map<string, Uint8Array>(), engine: vi.fn() }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/legacyVision', () => ({ legacyVisionHandler: state.engine }));
vi.mock('../src/services/storage', async (orig) => ({ ...(await orig<any>()), getObjectBytes: async (key: string, max: number) => {
  const b = state.objects.get(key); if (!b) throw new Error('object_missing'); if (b.byteLength > max) throw new Error('object_too_large'); return b; } }));
import { createApp } from '../src/app';
const app = createApp();
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const id: Record<string, string> = {}; const tok: Record<string, string> = {};
let n = 0;
async function photo(opening: string, orgKey: string) {
  const pid = randomUUID(), key = `private/org/${id[orgKey]}/opening/${opening}/${pid}.jpg`, bytes = new Uint8Array(16); bytes.set([255, 216, 255, ++n]);
  state.objects.set(key, bytes);
  await sql(`INSERT INTO photos(id,opening_id,related_entity_type,related_entity_id,storage_url,media_type,organization_id,content_type,byte_size,sha256_checksum,storage_object_key,upload_state)
    VALUES($1,$2,'opening',$2,$3,'photo',$4,'image/jpeg',16,$5,$6,'verified')`, [pid, opening, 'private:' + key, id[orgKey], sha(bytes), key]);
  return pid;
}
const run = (who: string, opening: string, photos: string[]) => request(app).post('/api/recognition/runs').set('Authorization', tok[who])
  .send({ opening_id: opening, photo_ids: photos, client_request_id: randomUUID() });
const month = new Date().toISOString().slice(0, 7);
const report = (who: string, m = month) => request(app).get('/api/platform/recognition-usage?month=' + m).set('Authorization', tok[who]);
const row = (body: any, k: string) => body.companies.find((c: any) => c.organization_id === id[k]);

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  process.env.OI_RECOGNITION_ENABLED = 'true'; process.env.ANTHROPIC_API_KEY = 'test-not-real';
  state.engine.mockResolvedValue({ statusCode: 200, body: JSON.stringify({ manufacturer: 'Example Co', confidence: { manufacturer: 0.9 } }) });
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + f, 'utf8')));
  for (const [k, t] of [['oi', 'internal'], ['cust', 'customer'], ['vortex', 'service_partner'], ['dhpace', 'service_partner']]) {
    id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], 'Synthetic ' + k, t]);
    id[k + 'User'] = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-password')", [id[k + 'User'], id[k], id[k + 'User'] + '@example.invalid']);
    tok[k] = 'Bearer ' + jwt.sign({ userId: id[k + 'User'], organizationId: id[k], role: 'admin', sessionVersion: 0 }, process.env.JWT_SECRET!);
  }
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic staff')", [id.oiUser]);
  const pf = randomUUID(), b = randomUUID(); id.prop = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Main')", [pf, id.cust]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [id.prop, pf]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, id.prop]);
  for (const o of ['O1', 'O2']) { id[o] = randomUUID(); await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1,$2,$3,$4,'door')", [id[o], b, o, 'qr-' + id[o]]); }
  for (const p of ['vortex', 'dhpace']) await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.prop, id[p], id.custUser]);
  // Vortex gets a tiny emergency cap (3 photos); others use the default cap.
  await sql("INSERT INTO recognition_safety_caps(organization_id,monthly_photo_cap,set_by_user_id,set_reason) VALUES($1,3,$2,'synthetic')", [id.vortex, id.oiUser]);
  // O1 is shared: Vortex (2 photos) and DH Pace (1 photo). O2: DH Pace (1) and the facility itself (1).
  expect((await run('vortex', id.O1, [await photo(id.O1, 'vortex'), await photo(id.O1, 'vortex')])).body.run.status).toBe('succeeded');
  expect((await run('dhpace', id.O1, [await photo(id.O1, 'dhpace')])).body.run.status).toBe('succeeded');
  expect((await run('dhpace', id.O2, [await photo(id.O2, 'dhpace')])).body.run.status).toBe('succeeded');
  expect((await run('cust', id.O2, [await photo(id.O2, 'cust')])).body.run.status).toBe('succeeded');
  // A refused run (Vortex over its cap of 3 with 2 more photos) is not counted anywhere.
  const refused = await run('vortex', id.O2, [await photo(id.O2, 'vortex'), await photo(id.O2, 'vortex')]);
  expect([refused.body.run.status, refused.body.run.failure_code]).toEqual(['refused', 'safety_cap_exceeded']);
}, 180000);
afterAll(async () => { await state.db?.close(); });

describe('OI staff recognition usage report', () => {
  it('is OI-staff only: providers and the facility get 403, anonymous 401; bad month 400', async () => {
    for (const k of ['vortex', 'dhpace', 'cust']) { const r = await report(k); expect(r.status).toBe(403); expect(r.text).not.toContain(id.O1); }
    expect((await request(app).get('/api/platform/recognition-usage')).status).toBe(401);
    expect((await report('oi', '2026-13')).status).toBe(400);
  });
  it('bills $0.75 per opening to the provider AND the facility; shared openings count once in totals', async () => {
    const r = await report('oi'); expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({ opening_price_cents_per_month: 75, cost_per_photo_usd: null, default_monthly_photo_cap: 80000, cap_warning_ratio: 0.8 });
    expect(row(r.body, 'vortex')).toMatchObject({ billable_openings: 1, revenue_cents: 75, photos_recognized: 3, runs: 2, requested_photos: 2, requested_runs: 1 });
    expect(row(r.body, 'dhpace')).toMatchObject({ billable_openings: 2, revenue_cents: 150, photos_recognized: 5, runs: 4, requested_photos: 2, requested_runs: 2 });
    expect(row(r.body, 'cust')).toMatchObject({ billable_openings: 2, revenue_cents: 150, photos_recognized: 5, runs: 4, requested_photos: 1, requested_runs: 1 });
    expect(row(r.body, 'oi')).toBeUndefined();
    expect(r.body.totals).toEqual({ distinct_openings: 2, photos_recognized: 5, runs: 4, recognition_cost_usd: null, revenue_cents: 375, cost_per_opening_usd: null });
    for (const c of r.body.companies) expect([c.recognition_cost_usd, c.cost_per_opening_usd]).toEqual([null, null]);
  });
  it('recognition cost per photo is configurable and counted once per opening', async () => {
    await sql("UPDATE recognition_usage_settings SET cost_per_photo_usd=0.01, updated_reason='synthetic'");
    const r = await report('oi');
    expect(row(r.body, 'vortex')).toMatchObject({ recognition_cost_usd: 0.03, cost_per_opening_usd: 0.03 });
    expect(row(r.body, 'dhpace')).toMatchObject({ recognition_cost_usd: 0.05, cost_per_opening_usd: 0.025 });
    expect(r.body.totals).toMatchObject({ recognition_cost_usd: 0.05, cost_per_opening_usd: 0.025, revenue_cents: 375 });
    await sql("UPDATE recognition_usage_settings SET cost_per_photo_usd=NULL");
  });
  it('flags companies at or above the warning ratio (default 80%) of their safety cap', async () => {
    const r = await report('oi');
    expect(row(r.body, 'vortex')).toMatchObject({ safety_cap_photos: 3, cap_warning: false }); expect(row(r.body, 'vortex').cap_used_ratio).toBeCloseTo(2 / 3, 3);
    expect(row(r.body, 'dhpace')).toMatchObject({ safety_cap_photos: 80000, cap_warning: false });
    await sql("UPDATE recognition_usage_settings SET cap_warning_ratio=0.6");
    expect(row((await report('oi')).body, 'vortex').cap_warning).toBe(true);
    await sql("UPDATE recognition_usage_settings SET cap_warning_ratio=0.8");
    await sql('UPDATE recognition_safety_caps SET monthly_photo_cap=2 WHERE organization_id=$1', [id.vortex]); // 2 of 2 = 100%
    expect(row((await report('oi')).body, 'vortex')).toMatchObject({ cap_warning: true, cap_used_ratio: 1 });
  });
  it('another month is empty; provider separation in the runs API is unchanged', async () => {
    const r = await report('oi', '2020-01'); expect(r.body.companies).toEqual([]); expect(r.body.totals.distinct_openings).toBe(0);
    const v = await request(app).get('/api/recognition/runs?opening_id=' + id.O1).set('Authorization', tok.vortex);
    expect(v.body.runs.every((x: any) => x.organization_id === id.vortex)).toBe(true);
    const d = await request(app).get('/api/recognition/runs?opening_id=' + id.O1).set('Authorization', tok.dhpace);
    expect(d.body.runs.every((x: any) => x.organization_id === id.dhpace)).toBe(true);
  });
});
