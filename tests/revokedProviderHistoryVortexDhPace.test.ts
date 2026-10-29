import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// Vortex / DH Pace separation after revocation (filter hardened in 387ccf9). Both providers work the
// same customer facility. Revoking Vortex removes Vortex's access to the facility AND to its own past
// events there; DH Pace keeps exactly its own history and never sees Vortex's (sharing off), before or
// after. Full app, every migration, disposable PGlite, synthetic data only.
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
import { createApp } from '../src/app';
import { serviceEventVisibleSql } from '../src/db/tenantScope';
const app = createApp();
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const id: Record<string, string> = {}; const tok: Record<string, string> = {};
const get = (path: string, who: string) => request(app).get(path).set('Authorization', tok[who]);
const visible = async (orgKey: string) => ((await sql(`SELECT se.id FROM service_events se WHERE se.opening_id=$1 AND ${serviceEventVisibleSql('se', 2)} ORDER BY se.id`, [id.open, id[orgKey]])).rows as any[]).map(r => r.id);
const assignment = (prov: string, revoked: boolean) => sql(`UPDATE facility_provider_assignments SET revoked_at=${revoked ? 'now()' : 'NULL'} WHERE property_id=$1 AND provider_organization_id=$2`, [id.prop, id[prov]]);

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  for (const [k, t] of [['cust', 'customer'], ['vortex', 'service_partner'], ['dhpace', 'service_partner']]) {
    id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], 'Synthetic ' + k, t]);
    id[k + 'User'] = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-password')", [id[k + 'User'], id[k], id[k + 'User'] + '@example.invalid']);
    tok[k] = 'Bearer ' + jwt.sign({ userId: id[k + 'User'], organizationId: id[k], role: 'admin', sessionVersion: 0 }, process.env.JWT_SECRET!);
  }
  const pf = randomUUID(); id.prop = randomUUID(); const b = randomUUID(); id.open = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Main')", [pf, id.cust]);
  await sql("INSERT INTO properties(id,portfolio_id,name,share_provider_service_history) VALUES($1,$2,'Synthetic shared facility',false)", [id.prop, pf]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, id.prop]);
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1,$2,'D-1',$3,'door')", [id.open, b, 'qr-' + id.open]);
  for (const prov of ['vortex', 'dhpace']) await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.prop, id[prov], id.custUser]);
  for (const k of ['vortex', 'dhpace', 'cust']) {
    id[k + 'Event'] = randomUUID();
    await sql("INSERT INTO service_events(id,opening_id,performed_by_org_id,event_date,work_performed) VALUES($1,$2,$3,'2026-10-29',$4)", [id[k + 'Event'], id.open, id[k], 'synthetic ' + k + ' work']);
  }
}, 180000);
afterAll(async () => { await state.db?.close(); });

describe('Vortex / DH Pace separation after revocation', () => {
  it('before revocation: each provider sees only its own events; the customer sees all', async () => {
    expect(await visible('vortex')).toEqual([id.vortexEvent]);
    expect(await visible('dhpace')).toEqual([id.dhpaceEvent]);
    expect(await visible('cust')).toEqual([id.vortexEvent, id.dhpaceEvent, id.custEvent].sort());
    const v = await get('/api/openings/' + id.open, 'vortex'); expect(v.status).toBe(200);
    expect(v.text).toContain(id.vortexEvent); expect(v.text).not.toContain(id.dhpaceEvent); expect(v.text).not.toContain(id.custEvent);
    const d = await get('/api/openings/' + id.open, 'dhpace'); expect(d.status).toBe(200);
    expect(d.text).toContain(id.dhpaceEvent); expect(d.text).not.toContain(id.vortexEvent);
  });
  it('revoking Vortex removes Vortex access to the facility and to its own past events there', async () => {
    await assignment('vortex', true);
    expect(await visible('vortex')).toEqual([]);
    const v = await get('/api/openings/' + id.open, 'vortex');
    expect([403, 404]).toContain(v.status); expect(v.text).not.toContain(id.vortexEvent);
    const props = await get('/api/portfolio/properties', 'vortex');
    expect(props.text).not.toContain(id.prop); expect(props.text).not.toContain(id.vortexEvent);
  });
  it('DH Pace is unaffected by the Vortex revocation and still never sees Vortex history', async () => {
    expect(await visible('dhpace')).toEqual([id.dhpaceEvent]);
    const d = await get('/api/openings/' + id.open, 'dhpace'); expect(d.status).toBe(200);
    expect(d.text).toContain(id.dhpaceEvent); expect(d.text).not.toContain(id.vortexEvent);
    expect(await visible('cust')).toHaveLength(3); // the customer keeps the full record; nothing is deleted
    expect((await sql('SELECT count(*)::int c FROM service_events WHERE id=$1', [id.vortexEvent])).rows[0].c).toBe(1);
  });
  it('revoking DH Pace too leaves neither provider any history; re-assigning restores only its own', async () => {
    await assignment('dhpace', true);
    expect(await visible('dhpace')).toEqual([]); expect(await visible('vortex')).toEqual([]);
    await assignment('vortex', false);
    expect(await visible('vortex')).toEqual([id.vortexEvent]); expect(await visible('dhpace')).toEqual([]);
    const v = await get('/api/openings/' + id.open, 'vortex'); expect(v.status).toBe(200); expect(v.text).not.toContain(id.dhpaceEvent);
    await assignment('dhpace', false);
  });
});
