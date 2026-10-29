import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// OI-staff-only edit of the per-opening price, the per-photo recognition cost and per-company safety
// caps (Oct 29 12:23 decision): validated, reason required, every change audited with old and new
// values. Full app, every migration (incl. DRAFT 090800), disposable PGlite, synthetic data only.
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
import { createApp } from '../src/app';
const app = createApp();
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const id: Record<string, string> = {}; const tok: Record<string, string> = {};
const month = new Date().toISOString().slice(0, 7);
const put = (path: string, body: unknown, who = 'oi') => request(app).put('/api/platform/recognition-usage' + path).set('Authorization', tok[who]).send(body);
const report = () => request(app).get('/api/platform/recognition-usage?month=' + month).set('Authorization', tok.oi);
const audits = async (action: string) => (await sql('SELECT actor_user_id, actor_org_id, target_org_id, reason, before_state, after_state FROM platform_audit_events WHERE action=$1 ORDER BY id', [action])).rows;

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + f, 'utf8')));
  for (const [k, t] of [['oi', 'internal'], ['cust', 'customer'], ['vortex', 'service_partner']]) {
    id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], 'Synthetic ' + k, t]);
    id[k + 'User'] = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-password')", [id[k + 'User'], id[k], id[k + 'User'] + '@example.invalid']);
    tok[k] = 'Bearer ' + jwt.sign({ userId: id[k + 'User'], organizationId: id[k], role: 'admin', sessionVersion: 0 }, process.env.JWT_SECRET!);
  }
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic staff')", [id.oiUser]);
  const pf = randomUUID(), pr = randomUUID(), b = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Main')", [pf, id.cust]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [pr, pf]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, pr]);
  for (const c of ['O1', 'O2']) await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,status) VALUES($1,$2,$3,$4,'door','active')", [randomUUID(), b, c, 'qr-' + randomUUID()]);
});

describe('OI staff edit of recognition price, cost and safety caps', () => {
  it('is OI-staff only: customers and providers get 403, anonymous 401', async () => {
    for (const who of ['cust', 'vortex']) {
      expect((await request(app).get('/api/platform/recognition-usage/settings').set('Authorization', tok[who])).status).toBe(403);
      expect((await put('/settings', { opening_price_cents_per_month: 1, reason: 'x' }, who)).status).toBe(403);
      expect((await put('/caps/' + id.cust, { monthly_photo_cap: 1, reason: 'x' }, who)).status).toBe(403);
    }
    expect((await request(app).put('/api/platform/recognition-usage/settings').send({ opening_price_cents_per_month: 1, reason: 'x' })).status).toBe(401);
    expect(await audits('usage_settings_changed')).toEqual([]);
  });
  it('validates input and requires a reason', async () => {
    for (const body of [{ opening_price_cents_per_month: -1, reason: 'r' }, { opening_price_cents_per_month: 1.5, reason: 'r' },
      { opening_price_cents_per_month: 100001, reason: 'r' }, { opening_price_cents_per_month: '75', reason: 'r' },
      { opening_price_cents_per_month: 80 }, { opening_price_cents_per_month: 80, reason: '   ' }, { reason: 'nothing' },
      { cost_per_photo_usd: -0.01, reason: 'r' }, { cost_per_photo_usd: 0.0000001, reason: 'r' }, { cap_warning_ratio: 1.2, reason: 'r' },
      { default_monthly_photo_cap: 0, reason: 'r' }, { opening_price_cents_per_month: 80, reason: 'r', extra: 1 }])
      expect((await put('/settings', body)).status, JSON.stringify(body)).toBe(400);
    for (const body of [{ monthly_photo_cap: 0, reason: 'r' }, { monthly_photo_cap: 2.5, reason: 'r' }, { monthly_photo_cap: 5 }, { reason: 'r' }])
      expect((await put('/caps/' + id.cust, body)).status, JSON.stringify(body)).toBe(400);
    expect((await put('/caps/not-a-uuid', { monthly_photo_cap: 5, reason: 'r' })).status).toBe(400);
    expect((await put('/caps/' + randomUUID(), { monthly_photo_cap: 5, reason: 'r' })).body.error).toBe('safety_cap_invalid_company');
    expect((await put('/caps/' + id.oi, { monthly_photo_cap: 5, reason: 'r' })).status).toBe(400);
    expect(await audits('usage_settings_changed')).toEqual([]);
    expect(await audits('safety_cap_set')).toEqual([]);
  });
  it('changes price and cost, audits old and new values with the reason, and the report uses them', async () => {
    const r = await put('/settings', { opening_price_cents_per_month: 100, cost_per_photo_usd: 0.002, reason: 'price review' });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ opening_price_cents_per_month: 100, default_monthly_photo_cap: 80000 });
    const a = await audits('usage_settings_changed');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_user_id: id.oiUser, actor_org_id: id.oi, reason: 'price review' });
    expect(a[0].before_state).toMatchObject({ opening_price_cents_per_month: 75, cost_per_photo_usd: null });
    expect(a[0].after_state).toMatchObject({ opening_price_cents_per_month: 100 });
    expect(Number(a[0].after_state.cost_per_photo_usd)).toBe(0.002);
    const rep = await report();
    expect(rep.body.settings.opening_price_cents_per_month).toBe(100);
    expect(rep.body.companies.find((c: any) => c.organization_id === id.cust)).toMatchObject({ billable_openings: 2, revenue_cents: 200 });
    // Omitting the cost keeps it; null clears it.
    await put('/settings', { cap_warning_ratio: 0.9, reason: 'warn later' });
    const g = await request(app).get('/api/platform/recognition-usage/settings').set('Authorization', tok.oi);
    expect(g.status).toBe(200);
    expect(g.body.settings).toMatchObject({ cost_per_photo_usd: 0.002, cap_warning_ratio: 0.9, updated_reason: 'warn later' });
    await put('/settings', { cost_per_photo_usd: null, reason: 'cost unknown again' });
    expect((await report()).body.settings.cost_per_photo_usd).toBeNull();
    expect(await audits('usage_settings_changed')).toHaveLength(3);
  });
  it('sets, changes and removes a company safety cap, audited each time', async () => {
    expect((await put('/caps/' + id.vortex, { monthly_photo_cap: 500, reason: 'pilot' })).status).toBe(200);
    expect((await put('/caps/' + id.vortex, { monthly_photo_cap: 900, reason: 'pilot extended' })).status).toBe(200);
    const g = await request(app).get('/api/platform/recognition-usage/settings').set('Authorization', tok.oi);
    expect(g.body.caps).toEqual([expect.objectContaining({ organization_id: id.vortex, monthly_photo_cap: 900, set_reason: 'pilot extended' })]);
    expect((await sql('SELECT set_by_user_id FROM recognition_safety_caps WHERE organization_id=$1', [id.vortex])).rows[0].set_by_user_id).toBe(id.oiUser);
    const set = await audits('safety_cap_set');
    expect(set.map((x: any) => [x.target_org_id, x.before_state.monthly_photo_cap, x.after_state.monthly_photo_cap, x.reason]))
      .toEqual([[id.vortex, null, 500, 'pilot'], [id.vortex, 500, 900, 'pilot extended']]);
    expect((await put('/caps/' + id.vortex, { monthly_photo_cap: null, reason: 'back to default' })).status).toBe(200);
    expect((await sql('SELECT count(*)::int n FROM recognition_safety_caps')).rows[0].n).toBe(0);
    const rm = await audits('safety_cap_removed');
    expect(rm).toHaveLength(1);
    expect(rm[0]).toMatchObject({ target_org_id: id.vortex, before_state: { monthly_photo_cap: 900 }, after_state: { monthly_photo_cap: null }, reason: 'back to default' });
  });
  it('database: the tables stay read-only for the API role; the functions re-check OI staff', async () => {
    const priv = (await sql(`SELECT has_table_privilege('oi_pr2_api','recognition_usage_settings','UPDATE') s,
      has_table_privilege('oi_pr2_api','recognition_safety_caps','INSERT') c,
      has_function_privilege('oi_pr2_api','recognition_safety_cap_set(uuid,uuid,uuid,integer,text)','EXECUTE') f,
      has_function_privilege('anon','recognition_safety_cap_set(uuid,uuid,uuid,integer,text)','EXECUTE') a`)).rows[0];
    expect(priv).toEqual({ s: false, c: false, f: true, a: false });
    await expect(sql('SELECT recognition_safety_cap_set($1,$2,$3,5,$4)', [id.custUser, id.cust, id.cust, 'r'])).rejects.toThrow(/usage_settings_requires_oi_staff/);
    await expect(sql('SELECT recognition_usage_settings_update($1,$2,$3,1,NULL,false,NULL,NULL)', [id.vortexUser, id.vortex, 'r'])).rejects.toThrow(/usage_settings_requires_oi_staff/);
    await expect(sql("UPDATE platform_audit_events SET reason='x' WHERE action='safety_cap_set'")).rejects.toThrow(/append_only/);
  });
});
