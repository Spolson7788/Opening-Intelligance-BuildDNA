import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ db: null as any, log: [] as { s: string; a?: unknown[] }[] }));
// t98: opening health count respects provider history sharing; properties list exposes is_owner for the dashboard toggle.
// In-process disposable SQL only; synthetic data only.
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => { state.log.push({ s, a }); return state.db.query(s, a); },
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
import { openingsRouter } from '../src/routes/openings';
import { portfolioRouter } from '../src/routes/portfolio';
import { photosRouter } from '../src/routes/photos';
import { lifecycleRouter } from '../src/routes/lifecycle';
import { conditionHistoryRouter } from '../src/routes/conditionHistory';
import { eventsRouter } from '../src/routes/events';
const app = express(); app.use(express.json());
app.use('/api/openings', openingsRouter); app.use('/api/portfolio', portfolioRouter); app.use('/api/photos', photosRouter);
app.use('/api/lifecycle', lifecycleRouter); app.use('/api/condition-history', conditionHistoryRouter); app.use('/api/events', eventsRouter);
const migration = '20261029100000_provider_history_sharing.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const hasColumn = async () => (await sql("SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name='properties' AND column_name='share_provider_service_history'")).rows[0].c > 0;
let rollbackProven = false, undoProven = false;
const ids: Record<string, string> = {};
async function org(name: string) { const id = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)", [id, name, name === 'Owner' ? 'customer' : 'service_partner']); return id; }
async function user(orgId: string, role: string) {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user',$4,'not-a-real-password')", [id, orgId, id + '@example.invalid', role]);
  return 'Bearer ' + jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion: 0 }, process.env.JWT_SECRET!);
}
async function facility(ownerOrg: string) {
  const portfolio = randomUUID(), property = randomUUID(), building = randomUUID(), opening = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio, ownerOrg]);
  await sql("INSERT INTO properties(id,portfolio_id,name,state) VALUES($1,$2,'Synthetic facility','CA')", [property, portfolio]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')", [building, property]);
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,opening_configuration) VALUES($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'door','pair')", [opening, building]);
  return { property, opening };
}
async function event(opening: string, orgId: string | null, text: string) {
  const id = randomUUID();
  await sql("INSERT INTO service_events(id,opening_id,performed_by_org_id,event_date,work_performed) VALUES($1,$2,$3,'2026-10-01',$4)", [id, opening, orgId, text]);
  return id;
}
const tok: Record<string, string> = {};
beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < migration).sort()) await state.db.exec(fix(readFileSync('migrations/' + name, 'utf8')));
  const script = readFileSync('migrations/' + migration, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;');
  rollbackProven = !(await hasColumn());
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  await state.db.exec(readFileSync('docs/rollback/20261029100000_provider_history_sharing_rollback.sql', 'utf8'));
  undoProven = !(await hasColumn());
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  ids.owner = await org('Owner'); ids.vortex = await org('Vortex'); ids.dh = await org('DH Pace');
  tok.ownerAdmin = await user(ids.owner, 'admin'); tok.ownerTech = await user(ids.owner, 'technician');
  tok.vortexAdmin = await user(ids.vortex, 'admin'); tok.vortexTech = await user(ids.vortex, 'technician');
  tok.dhAdmin = await user(ids.dh, 'admin'); tok.dhTech = await user(ids.dh, 'technician');
  const shared = await facility(ids.owner); ids.shared = shared.property; ids.opening = shared.opening;
  const dhOnly = await facility(ids.owner); ids.dhOnly = dhOnly.property; ids.dhOpening = dhOnly.opening;
  for (const [p, o] of [[ids.shared, ids.vortex], [ids.shared, ids.dh], [ids.dhOnly, ids.dh]])
    await sql("INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,(SELECT id FROM users WHERE organization_id=$3 AND role='admin' LIMIT 1))", [p, o, ids.owner]);
  ids.eOwner = await event(ids.opening, ids.owner, 'owner work');
  ids.eVortex = await event(ids.opening, ids.vortex, 'vortex work');
  ids.eDh = await event(ids.opening, ids.dh, 'dh pace work');
  ids.eLegacy = await event(ids.opening, null, 'legacy work');
  ids.pDh = randomUUID(); ids.pVortex = randomUUID(); ids.pOpening = randomUUID();
  for (const [pid, type, rel] of [[ids.pDh, 'service_event', ids.eDh], [ids.pVortex, 'service_event', ids.eVortex], [ids.pOpening, 'opening', ids.opening]])
    await sql("INSERT INTO photos(id,opening_id,related_entity_type,related_entity_id,storage_url) VALUES($1,$2,$3,$4,'synthetic://photo')", [pid, ids.opening, type, rel]);
}, 120000);
afterAll(async () => { await state.db?.close(); });

const texts = (rows: any[]) => rows.map((r: any) => r.work_performed).sort();
async function openingEvents(t: string) { const r = await request(app).get('/api/openings/' + ids.opening).set('Authorization', t); expect(r.status).toBe(200); return r.body; }
async function setSharing(t: string, enabled: boolean, property = ids.shared) { return request(app).put(`/api/portfolio/properties/${property}/provider-history-sharing`).set('Authorization', t).send({ enabled }); }


async function healthCount(t: string) {
  state.log.length = 0;
  const r = await request(app).post('/api/openings/' + ids.opening + '/recompute-health-score').set('Authorization', t);
  expect(r.status).toBe(200);
  const q = state.log.find(x => /COUNT\(\*\) FROM service_events/.test(x.s));
  expect(q).toBeTruthy();
  return Number((await sql(q!.s, q!.a)).rows[0].count);
}
describe('t98 health count respects provider history sharing', () => {
  it('owner counts all recent events; providers count only their own while sharing is off', async () => {
    expect(await healthCount(tok.ownerAdmin)).toBe(4);
    expect(await healthCount(tok.vortexAdmin)).toBe(1);
    expect(await healthCount(tok.dhAdmin)).toBe(1);
  });
  it('providers count every event once the owner admin turns sharing on, and back to own when off', async () => {
    expect((await setSharing(tok.ownerAdmin, true)).status).toBe(200);
    expect(await healthCount(tok.vortexAdmin)).toBe(4);
    expect((await setSharing(tok.ownerAdmin, false)).status).toBe(200);
    expect(await healthCount(tok.vortexAdmin)).toBe(1);
  });
});
describe('t98 properties list flags ownership for the dashboard toggle', () => {
  it('is_owner is true only for the owner org and the sharing flag is returned', async () => {
    const o = await request(app).get('/api/portfolio/properties').set('Authorization', tok.ownerAdmin);
    const v = await request(app).get('/api/portfolio/properties').set('Authorization', tok.vortexAdmin);
    expect(o.status).toBe(200); expect(v.status).toBe(200);
    const os = o.body.find((p: any) => p.id === ids.shared), vs = v.body.find((p: any) => p.id === ids.shared);
    expect(os.is_owner).toBe(true); expect(vs.is_owner).toBe(false);
    expect(os.share_provider_service_history).toBe(false);
    expect((await setSharing(tok.vortexAdmin, true)).status).toBe(403);
  });
});
