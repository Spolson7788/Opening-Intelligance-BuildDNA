import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// OI-staff-only usage and billing report (Oct 29 11:42 decision): $0.75 per ACTIVE opening per month,
// whether or not recognition ran; the facility owner AND each provider assigned that month pay; a
// provider's own facility is billed once; recognition cost is OI's internal cost (margin shown);
// 80%-of-safety-cap warning; staff-created provider-owned facilities stay provider-separated. Full app, every migration (incl. DRAFT 090800),
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

const staffPost = (path: string, body: unknown, who = 'oi') => request(app).post('/api/platform' + path).set('Authorization', tok[who]).send(body);
async function opening(building: string, code: string) {
  const o = randomUUID(); await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1,$2,$3,$4,'door')", [o, building, code, 'qr-' + o]); return o;
}

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
  // Customer facility: O1, O2 active; O3 was active only in Jan 2020 (decommissioned since).
  const pf = randomUUID(), b = randomUUID(); id.prop = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Main')", [pf, id.cust]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [id.prop, pf]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, id.prop]);
  id.O1 = await opening(b, 'O1'); id.O2 = await opening(b, 'O2'); id.O3 = await opening(b, 'O3');
  await sql("UPDATE openings SET status='decommissioned' WHERE id=$1", [id.O3]);
  await sql("UPDATE opening_active_periods SET started_at='2020-01-10', ended_at='2020-01-20' WHERE opening_id=$1", [id.O3]);
  for (const p of ['vortex', 'dhpace']) await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.prop, id[p], id.custUser]);
  // DH Pace is revoked during the month: it still pays for this month.
  await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [id.prop, id.dhpace]);
  // Vortex's own facility (created by OI staff) with one opening V1.
  const vf = await staffPost(`/providers/${id.vortex}/facilities`, { name: 'Vortex general', reason: 'synthetic provider facility' });
  expect(vf.status).toBe(201); id.vprop = vf.body.facility.id;
  const vb = randomUUID(); await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'VB')", [vb, id.vprop]);
  id.V1 = await opening(vb, 'V1');
  await sql("INSERT INTO recognition_safety_caps(organization_id,monthly_photo_cap,set_by_user_id,set_reason) VALUES($1,3,$2,'synthetic')", [id.vortex, id.oiUser]);
  // Recognition: Vortex 2 photos on O1, the customer 1 photo on O2; a refused Vortex run is not counted.
  expect((await run('vortex', id.O1, [await photo(id.O1, 'vortex'), await photo(id.O1, 'vortex')])).body.run.status).toBe('succeeded');
  expect((await run('cust', id.O2, [await photo(id.O2, 'cust')])).body.run.status).toBe('succeeded');
  const refused = await run('vortex', id.V1, [await photo(id.V1, 'vortex'), await photo(id.V1, 'vortex')]);
  expect([refused.body.run.status, refused.body.run.failure_code]).toEqual(['refused', 'safety_cap_exceeded']);
}, 180000);
afterAll(async () => { await state.db?.close(); });

describe('OI staff usage and billing report', () => {
  it('is OI-staff only: providers and the facility get 403, anonymous 401; bad month 400', async () => {
    for (const k of ['vortex', 'dhpace', 'cust']) { const r = await report(k); expect(r.status).toBe(403); expect(r.text).not.toContain(id.O1); }
    expect((await request(app).get('/api/platform/recognition-usage')).status).toBe(401);
    expect((await report('oi', '2026-13')).status).toBe(400);
  });
  it('bills $0.75 per active opening to the owner and to each provider assigned that month; own facility once', async () => {
    const r = await report('oi'); expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({ opening_price_cents_per_month: 75, cost_per_photo_usd: null, default_monthly_photo_cap: 80000, cap_warning_ratio: 0.8 });
    // Customer: O1+O2 (O3 decommissioned all month). No recognition needed to be billed.
    expect(row(r.body, 'cust')).toMatchObject({ owned_openings: 2, provider_openings: 0, billable_openings: 2, revenue_cents: 150, photos_recognized: 1, runs: 1 });
    // Vortex: its own V1 once + O1, O2 as assigned provider.
    expect(row(r.body, 'vortex')).toMatchObject({ owned_openings: 1, provider_openings: 2, billable_openings: 3, revenue_cents: 225, photos_recognized: 2, runs: 1 });
    // DH Pace: revoked this month, ran no recognition, still pays for O1, O2 this month.
    expect(row(r.body, 'dhpace')).toMatchObject({ owned_openings: 0, provider_openings: 2, billable_openings: 2, revenue_cents: 150, photos_recognized: 0, runs: 0 });
    expect(row(r.body, 'oi')).toBeUndefined();
    expect(r.body.totals).toEqual({ active_openings: 3, billable_openings: 7, revenue_cents: 525, photos_recognized: 3, runs: 2, oi_recognition_cost_usd: null, margin_usd: null });
    for (const c of r.body.companies) expect([c.oi_recognition_cost_usd, c.margin_usd]).toEqual([null, null]);
  });
  it('uses history: Jan 2020 bills only O3 to its owner (providers were not assigned then)', async () => {
    const r = await report('oi', '2020-01');
    expect(r.body.companies.map((c: any) => c.organization_id)).toEqual([id.cust]);
    expect(row(r.body, 'cust')).toMatchObject({ owned_openings: 1, billable_openings: 1, revenue_cents: 75, photos_recognized: 0 });
    expect((await report('oi', '2019-12')).body.companies).toEqual([]);
  });
  it('a re-grant keeps the earlier assignment period (the current row is overwritten)', async () => {
    await sql('UPDATE facility_provider_assignments SET revoked_at=NULL, granted_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [id.prop, id.dhpace]);
    const p = await sql('SELECT ended_at FROM facility_provider_assignment_periods WHERE property_id=$1 AND provider_organization_id=$2 ORDER BY id', [id.prop, id.dhpace]);
    expect(p.rows.map((x: any) => x.ended_at === null)).toEqual([false, true]);
    expect(row((await report('oi')).body, 'dhpace').billable_openings).toBe(2); // still once per opening
  });
  it('OI recognition cost is internal: shown with margin, never added to revenue', async () => {
    await sql("UPDATE recognition_usage_settings SET cost_per_photo_usd=0.01, updated_reason='synthetic'");
    const r = await report('oi');
    expect(row(r.body, 'vortex')).toMatchObject({ revenue_cents: 225, oi_recognition_cost_usd: 0.02, margin_usd: 2.23 });
    expect(row(r.body, 'dhpace')).toMatchObject({ oi_recognition_cost_usd: 0, margin_usd: 1.5 });
    expect(r.body.totals).toMatchObject({ revenue_cents: 525, oi_recognition_cost_usd: 0.03, margin_usd: 5.22 });
    await sql("UPDATE recognition_usage_settings SET cost_per_photo_usd=NULL");
  });
  it('flags companies at or above the warning ratio (default 80%) of their safety cap', async () => {
    expect(row((await report('oi')).body, 'vortex')).toMatchObject({ safety_cap_photos: 3, cap_warning: false });
    await sql('UPDATE recognition_safety_caps SET monthly_photo_cap=2 WHERE organization_id=$1', [id.vortex]);
    expect(row((await report('oi')).body, 'vortex')).toMatchObject({ cap_warning: true, cap_used_ratio: 1 });
    expect(row((await report('oi')).body, 'cust')).toMatchObject({ safety_cap_photos: 80000, cap_warning: false });
  });
  it('provider-owned facility: staff only, providers only, and never visible to another provider', async () => {
    expect((await staffPost(`/providers/${id.dhpace}/facilities`, { name: 'x', reason: 'y' }, 'dhpace')).status).toBe(403);
    expect((await staffPost(`/providers/${id.cust}/facilities`, { name: 'x', reason: 'y' })).body.error).toBe('provider_facility_requires_provider');
    expect((await staffPost(`/providers/${id.vortex}/facilities`, { name: 'x' })).status).toBe(400);
    expect((await request(app).get('/api/openings/' + id.V1).set('Authorization', tok.vortex)).status).toBe(200);
    for (const k of ['dhpace', 'cust']) expect((await request(app).get('/api/openings/' + id.V1).set('Authorization', tok[k])).status).toBe(404);
    const a = await sql("SELECT after_state FROM platform_audit_events WHERE action='facility_created' AND target_id=$1", [id.vprop]);
    expect(a.rows[0].after_state).toMatchObject({ provider_owned: true });
  });
  it('creating a provider company can create its own facility too (customers cannot)', async () => {
    const base = { org_type: 'service_partner', admin_full_name: 'Synthetic', reason: 'synthetic', create_provider_facility: true };
    const r = await staffPost('/companies', { ...base, name: 'Synthetic Acme', admin_email: 'acme-' + randomUUID() + '@example.invalid' });
    expect(r.status).toBe(201); expect(r.body.provider_facility.name).toBe('Synthetic Acme (own facility)');
    const own = await sql('SELECT pf.organization_id FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id WHERE p.id=$1', [r.body.provider_facility.id]);
    expect(own.rows[0].organization_id).toBe(r.body.organization.id);
    const c = await staffPost('/companies', { ...base, org_type: 'customer', name: 'Synthetic Cust2', admin_email: 'c2-' + randomUUID() + '@example.invalid' });
    expect(c.body.error).toBe('provider_facility_requires_provider');
    expect((await sql("SELECT 1 FROM organizations WHERE name='Synthetic Cust2'")).rows).toHaveLength(0); // rolled back
  });
  it('provider separation in the runs API is unchanged', async () => {
    const v = await request(app).get('/api/recognition/runs?opening_id=' + id.O1).set('Authorization', tok.vortex);
    expect(v.body.runs.every((x: any) => x.organization_id === id.vortex)).toBe(true);
    const d = await request(app).get('/api/recognition/runs?opening_id=' + id.O1).set('Authorization', tok.dhpace);
    expect((d.body.runs ?? []).every((x: any) => x.organization_id === id.dhpace)).toBe(true);
  });
});
