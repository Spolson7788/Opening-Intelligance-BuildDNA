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
async function opening(building: string, code: string, status = 'active') {
  const o = randomUUID(); await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,status) VALUES($1,$2,$3,$4,'door',$5)", [o, building, code, 'qr-' + o, status]); return o;
}
let custBuilding = '';

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
  custBuilding = b;
  id.O1 = await opening(b, 'O1'); id.O2 = await opening(b, 'O2');
  // O3: decommissioned now; its history says it was billable 10-20 Jan 2020 only.
  id.O3 = await opening(b, 'O3', 'decommissioned');
  await sql("INSERT INTO opening_billable_periods(opening_id,opening_code,property_id,property_name,owner_organization_id,started_at,ended_at,end_reason) VALUES($1,'O3',$2,'Synthetic facility',$3,'2020-01-10','2020-01-20','backfill')", [id.O3, id.prop, id.cust]);
  // P1: uncaptured placeholder (pending_capture) - not billable.
  id.P1 = await opening(b, 'P1', 'pending_capture');
  for (const p of ['vortex', 'dhpace']) await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.prop, id[p], id.custUser]);
  // DH Pace is revoked during the month: it still pays for O1, O2 this month, but not for O4 (added after it left).
  await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [id.prop, id.dhpace]);
  await new Promise((r) => setTimeout(r, 5));
  id.O4 = await opening(b, 'O4');
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
  it('bills $0.75 per billable opening to the owner, and to each provider only for openings billable while it was assigned', async () => {
    const r = await report('oi'); expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({ opening_price_cents_per_month: 75, cost_per_photo_usd: null, default_monthly_photo_cap: 80000, cap_warning_ratio: 0.8 });
    // Customer: O1, O2, O4 (O3 decommissioned all month, P1 pending_capture). No recognition needed to be billed.
    expect(row(r.body, 'cust')).toMatchObject({ owned_openings: 3, provider_openings: 0, billable_openings: 3, revenue_cents: 225, photos_recognized: 1, runs: 1 });
    // Vortex: its own V1 once + O1, O2, O4 as assigned provider.
    expect(row(r.body, 'vortex')).toMatchObject({ owned_openings: 1, provider_openings: 3, billable_openings: 4, revenue_cents: 300, photos_recognized: 2, runs: 1 });
    // DH Pace: revoked this month, ran no recognition: pays for O1, O2 but not O4 (added after it left).
    expect(row(r.body, 'dhpace')).toMatchObject({ owned_openings: 0, provider_openings: 2, billable_openings: 2, revenue_cents: 150, photos_recognized: 0, runs: 0 });
    expect(row(r.body, 'oi')).toBeUndefined();
    expect(r.body.totals).toEqual({ active_openings: 4, billable_openings: 9, revenue_cents: 675, photos_recognized: 3, runs: 2, oi_recognition_cost_usd: null, margin_usd: null });
    for (const c of r.body.companies) expect([c.oi_recognition_cost_usd, c.margin_usd]).toEqual([null, null]);
  });
  it('uses history: Jan 2020 bills only O3 to its owner (providers were not assigned then)', async () => {
    const r = await report('oi', '2020-01');
    expect(r.body.companies.map((c: any) => c.organization_id)).toEqual([id.cust]);
    expect(row(r.body, 'cust')).toMatchObject({ owned_openings: 1, billable_openings: 1, revenue_cents: 75, photos_recognized: 0 });
    expect((await report('oi', '2019-12')).body.companies).toEqual([]);
  });
  it('OI recognition cost is internal: shown with margin, never added to revenue', async () => {
    await sql("UPDATE recognition_usage_settings SET cost_per_photo_usd=0.01, updated_reason='synthetic'");
    const r = await report('oi');
    expect(row(r.body, 'vortex')).toMatchObject({ revenue_cents: 300, oi_recognition_cost_usd: 0.02, margin_usd: 2.98 });
    expect(row(r.body, 'dhpace')).toMatchObject({ oi_recognition_cost_usd: 0, margin_usd: 1.5 });
    expect(r.body.totals).toMatchObject({ revenue_cents: 675, oi_recognition_cost_usd: 0.03, margin_usd: 6.72 });
    await sql("UPDATE recognition_usage_settings SET cost_per_photo_usd=NULL");
  });
  it('a re-grant keeps the earlier assignment period and bills openings billable during the new one', async () => {
    await sql('UPDATE facility_provider_assignments SET revoked_at=NULL, granted_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [id.prop, id.dhpace]);
    const p = await sql('SELECT end_reason FROM facility_provider_assignment_periods WHERE property_id=$1 AND provider_organization_id=$2 ORDER BY id', [id.prop, id.dhpace]);
    expect(p.rows.map((x: any) => x.end_reason)).toEqual(['revoked', null]);
    expect(row((await report('oi')).body, 'dhpace').billable_openings).toBe(3); // O1, O2 once each + O4 now
  });
  it('pending_capture bills only once captured', async () => {
    expect(row((await report('oi')).body, 'cust').owned_openings).toBe(3);
    await sql("UPDATE openings SET status='active' WHERE id=$1", [id.P1]);
    expect(row((await report('oi')).body, 'cust').owned_openings).toBe(4);
  });
  it('billing history survives deleting an opening or a facility, and cannot be edited or deleted', async () => {
    const d = await opening(custBuilding, 'D1');
    await sql('DELETE FROM openings WHERE id=$1', [d]);
    const h = await sql('SELECT opening_code, owner_organization_id, end_reason FROM opening_billable_periods WHERE opening_id=$1', [d]);
    expect(h.rows).toEqual([{ opening_code: 'D1', owner_organization_id: id.cust, end_reason: 'opening_deleted' }]);
    expect(row((await report('oi')).body, 'cust').owned_openings).toBe(5); // still billed this month
    const pf = (await sql('SELECT portfolio_id FROM properties WHERE id=$1', [id.prop])).rows[0].portfolio_id, x = randomUUID();
    await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Short-lived')", [x, pf]);
    await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [x, id.vortex, id.custUser]);
    await sql('DELETE FROM properties WHERE id=$1', [x]);
    expect((await sql('SELECT end_reason FROM facility_provider_assignment_periods WHERE property_id=$1', [x])).rows).toEqual([{ end_reason: 'assignment_deleted' }]);
    await expect(sql('DELETE FROM opening_billable_periods WHERE opening_id=$1', [d])).rejects.toThrow(/billing_history_no_delete/);
    await expect(sql("UPDATE opening_billable_periods SET ended_at=now() WHERE opening_id=$1", [d])).rejects.toThrow(/billing_history_immutable/);
    await expect(sql('DELETE FROM facility_provider_assignment_periods WHERE property_id=$1', [x])).rejects.toThrow(/billing_history_no_delete/);
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
  it('only OI staff can assign another provider to a provider-owned facility (API and database)', async () => {
    const put = (who: string, provider: string, active: boolean) => request(app).put(`/api/provider-assignments/${id.vprop}/${id[provider]}`).set('Authorization', tok[who]).send({ active });
    const r = await put('vortex', 'dhpace', true);
    expect([r.status, r.body.error]).toEqual([403, 'provider_facility_assignment_requires_oi_staff']);
    expect((await put('dhpace', 'dhpace', true)).status).toBe(404); // not its facility
    const ins = 'INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)';
    await expect(sql(ins, [id.vprop, id.dhpace, id.vortexUser])).rejects.toThrow(/provider_facility_assignment_requires_oi_staff/);
    await sql('BEGIN'); await sql("SELECT set_config('oi.actor_user_id',$1,true)", [id.vortexUser]);
    await expect(sql(ins, [id.vprop, id.dhpace, id.vortexUser])).rejects.toThrow(/provider_facility_assignment_requires_oi_staff/); await sql('ROLLBACK');
    // OI staff may (inside a transaction naming the staff actor); revoking is open to the owner.
    const before = row((await report('oi')).body, 'dhpace');
    await sql('BEGIN'); await sql("SELECT set_config('oi.actor_user_id',$1,true)", [id.oiUser]); await sql(ins, [id.vprop, id.dhpace, id.oiUser]); await sql('COMMIT');
    // Billing: on a provider-owned facility only the owning provider pays; DH Pace is not billed for V1.
    const during = await report('oi');
    expect(row(during.body, 'dhpace').billable_openings).toBe(before.billable_openings);
    expect(row(during.body, 'vortex')).toMatchObject({ owned_openings: 1 });
    expect((await put('vortex', 'dhpace', false)).status).toBe(200);
    expect((await sql('SELECT revoked_at FROM facility_provider_assignments WHERE property_id=$1 AND provider_organization_id=$2', [id.vprop, id.dhpace])).rows[0].revoked_at).not.toBeNull();
    // Customer facilities are unchanged: the owner admin can still assign providers.
    expect((await request(app).put(`/api/provider-assignments/${id.prop}/${id.vortex}`).set('Authorization', tok.cust).send({ active: true })).status).toBe(200);
  });
  it('go-live backfill: openings already active when 090800 is applied bill from apply time, not creation', async () => {
    const t0 = Date.now() - 1000;
    await sql('ALTER TABLE openings DISABLE TRIGGER opening_billable_periods_track');
    const g = randomUUID(), pend = randomUUID(), dec = randomUUID();
    for (const [o, st] of [[g, 'active'], [pend, 'pending_capture'], [dec, 'decommissioned']])
      await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,status,created_at) VALUES($1,$2,$3,$4,'door',$5,'2020-01-05')", [o, custBuilding, 'G-' + o.slice(0, 8), 'qr-' + o, st]);
    await sql('ALTER TABLE openings ENABLE TRIGGER opening_billable_periods_track');
    const mig = readFileSync('migrations/20261030090800_recognition_budget_guard.sql', 'utf8');
    await state.db.exec(mig.slice(mig.indexOf('-- BACKFILL-BEGIN'), mig.indexOf('-- BACKFILL-END')));
    const p = await sql('SELECT opening_id, started_at FROM opening_billable_periods WHERE opening_id = ANY($1::uuid[])', [[g, pend, dec]]);
    expect(p.rows.map((x: any) => x.opening_id)).toEqual([g]);
    expect(new Date(p.rows[0].started_at).getTime()).toBeGreaterThanOrEqual(t0); // apply time, not 2020-01-05
    expect((await report('oi', '2020-01')).body.companies.map((c: any) => c.organization_id)).toEqual([id.cust]); // still only O3 then
    // Re-running the backfill adds nothing.
    await state.db.exec(mig.slice(mig.indexOf('-- BACKFILL-BEGIN'), mig.indexOf('-- BACKFILL-END')));
    expect((await sql('SELECT count(*)::int n FROM opening_billable_periods WHERE opening_id=$1', [g])).rows[0].n).toBe(1);
  });
  it('a facility that changes owner: history switches at the move; the move month bills only the month-end owner', async () => {
    const custBefore = row((await report('oi')).body, 'cust').owned_openings;
    const c2 = randomUUID(), pf2 = randomUUID(), m = randomUUID(), mb = randomUUID();
    await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic cust2','customer')", [c2]);
    await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Main')", [pf2, c2]);
    const pf = (await sql('SELECT portfolio_id FROM properties WHERE id=$1', [id.prop])).rows[0].portfolio_id;
    await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Moving facility')", [m, pf]);
    await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'MB')", [mb, m]);
    const m1 = await opening(mb, 'M1');
    await sql('UPDATE properties SET portfolio_id=$1 WHERE id=$2', [pf2, m]);
    const h = await sql('SELECT owner_organization_id, end_reason FROM opening_billable_periods WHERE opening_id=$1 ORDER BY id', [m1]);
    expect(h.rows).toEqual([{ owner_organization_id: id.cust, end_reason: 'owner_changed' }, { owner_organization_id: c2, end_reason: null }]);
    const r = await report('oi');
    expect(r.body.companies.find((c: any) => c.organization_id === c2)).toMatchObject({ owned_openings: 1, revenue_cents: 75 });
    expect(row(r.body, 'cust').owned_openings).toBe(custBefore); // not billed to both owners
    // A building move to another owner's facility switches too; a move within the same owner does not.
    await sql('UPDATE buildings SET property_id=$1 WHERE id=$2', [id.prop, mb]);
    expect((await sql('SELECT owner_organization_id FROM opening_billable_periods WHERE opening_id=$1 AND ended_at IS NULL', [m1])).rows).toEqual([{ owner_organization_id: id.cust }]);
    const back = await report('oi');
    expect(row(back.body, 'cust').owned_openings).toBe(custBefore + 1);
    expect(back.body.companies.find((c: any) => c.organization_id === c2)?.owned_openings ?? 0).toBe(0);
    const n = (await sql('SELECT count(*)::int n FROM opening_billable_periods WHERE opening_id=$1', [m1])).rows[0].n;
    await sql("UPDATE openings SET building_id=(SELECT id FROM buildings WHERE property_id=$1 AND id<>$2 LIMIT 1) WHERE id=$3", [id.prop, mb, m1]);
    expect((await sql('SELECT count(*)::int n FROM opening_billable_periods WHERE opening_id=$1', [m1])).rows[0].n).toBe(n);
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
