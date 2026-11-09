import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ db: null as any }));
// t97 item 2: per-facility provider history sharing (default off), plus the Vortex / DH Pace wall.
// In-process disposable SQL only; synthetic data only.
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
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

describe('migration 20261029100000_provider_history_sharing', () => {
  it('is additive, defaults to off, rolls back in a transaction and has a working undo script', async () => {
    expect(rollbackProven).toBe(true); expect(undoProven).toBe(true);
    const r = await sql('SELECT share_provider_service_history AS s FROM properties WHERE id=$1', [ids.shared]);
    expect(r.rows[0].s).toBe(false);
  });
});

describe('provider history sharing OFF (default)', () => {
  it('owner sees every service event and every photo on the opening', async () => {
    const b = await openingEvents(tok.ownerTech);
    expect(texts(b.service_events)).toEqual(['dh pace work', 'legacy work', 'owner work', 'vortex work']);
    expect(b.photos.map((p: any) => p.id).sort()).toEqual([ids.pDh, ids.pOpening, ids.pVortex].sort());
  });
  it('Vortex sees only its own events and photos (opening detail = field download path)', async () => {
    const b = await openingEvents(tok.vortexTech);
    expect(texts(b.service_events)).toEqual(['vortex work']);
    expect(b.photos.map((p: any) => p.id).sort()).toEqual([ids.pOpening, ids.pVortex].sort());
  });
  it('DH Pace sees only its own events', async () => {
    expect(texts((await openingEvents(tok.dhTech)).service_events)).toEqual(['dh pace work']);
  });
  it('the by-qr and by-code entry points apply the same rule', async () => {
    for (const path of ['/api/openings/by-qr/' + ids.opening, '/api/openings/by-code/' + ids.opening]) {
      const r = await request(app).get(path).set('Authorization', tok.vortexTech);
      if (r.status === 200) expect(texts(r.body.service_events)).toEqual(['vortex work']);
      else expect([404]).toContain(r.status);
    }
  });
  it('photo list and photo access hide another provider\'s service-event photos', async () => {
    const list = await request(app).get('/api/photos/by-opening/' + ids.opening).set('Authorization', tok.vortexTech);
    expect(list.status).toBe(200);
    expect(list.body.map((p: any) => p.id)).not.toContain(ids.pDh);
    const access = await request(app).get(`/api/photos/${ids.pDh}/access`).set('Authorization', tok.vortexTech);
    expect(access.status).not.toBe(200);
  });
  it('a provider admin does not receive the customer facility dashboard', async () => {
    const r = await request(app).get('/api/portfolio/facility-dashboard/' + ids.shared).set('Authorization', tok.vortexAdmin);
    expect(r.status).toBe(403);
    expect(r.body.openings).toBeUndefined();
    const owner = await request(app).get('/api/portfolio/facility-dashboard/' + ids.shared).set('Authorization', tok.ownerAdmin);
    expect(owner.status).toBe(200);
    const o = owner.body.openings.find((x: any) => x.id === ids.opening);
    expect(texts(o.service_events)).toEqual(['dh pace work', 'legacy work', 'owner work', 'vortex work']);
  });
  it('lifecycle and facility condition-history reports filter service events', async () => {
    const life = await request(app).get('/api/lifecycle/' + ids.opening).set('Authorization', tok.dhTech);
    expect(life.status).toBe(200); expect(texts(life.body.service_events)).toEqual(['dh pace work']);
    const hist = await request(app).get('/api/condition-history/facility/' + ids.opening).set('Authorization', tok.dhTech);
    if (hist.status === 200) expect(texts(hist.body.service_events ?? [])).toEqual(['dh pace work']);
    else expect([403, 404]).toContain(hist.status);
  });
});

describe('the provider wall (Vortex vs DH Pace)', () => {
  it('Vortex cannot read a facility or opening assigned only to DH Pace', async () => {
    expect((await request(app).get('/api/openings/' + ids.dhOpening).set('Authorization', tok.vortexTech)).status).toBe(404);
    expect((await request(app).get('/api/portfolio/facility-dashboard/' + ids.dhOnly).set('Authorization', tok.vortexAdmin)).status).toBe(403);
    const list = await request(app).get('/api/portfolio/properties').set('Authorization', tok.vortexAdmin);
    expect(list.body.map((p: any) => p.id)).toEqual([ids.shared]);
    const dh = await request(app).get('/api/portfolio/properties').set('Authorization', tok.dhAdmin);
    expect(dh.body.map((p: any) => p.id).sort()).toEqual([ids.dhOnly, ids.shared].sort());
  });
  it('a provider cannot claim another organization as performer of a new service event', async () => {
    const r = await request(app).post('/api/events/service-events').set('Authorization', tok.vortexTech)
      .send({ opening_id: ids.opening, performed_by_org_id: ids.dh, event_date: '2026-10-02', work_performed: 'spoof attempt' });
    if (r.status === 201 || r.status === 200) {
      const row = (await sql("SELECT performed_by_org_id FROM service_events WHERE work_performed='spoof attempt'")).rows[0];
      expect(row.performed_by_org_id).toBe(ids.vortex);
    } else expect(r.status).toBe(403);
  });
});

describe('changing the setting', () => {
  it('only the facility owner\'s admin can change it', async () => {
    expect((await setSharing(tok.vortexAdmin, true)).status).toBe(403);
    expect((await setSharing(tok.dhAdmin, true)).status).toBe(403);
    expect((await setSharing(tok.ownerTech, true)).status).toBe(403);
    expect((await sql('SELECT share_provider_service_history AS s FROM properties WHERE id=$1', [ids.shared])).rows[0].s).toBe(false);
    expect((await request(app).put(`/api/portfolio/properties/${ids.shared}/provider-history-sharing`).set('Authorization', tok.ownerAdmin).send({ enabled: 'yes' })).status).toBe(400);
  });
  it('when the owner turns it on, assigned providers see each other\'s history; off again restores the wall', async () => {
    const on = await setSharing(tok.ownerAdmin, true);
    expect(on.status).toBe(200); expect(on.body.share_provider_service_history).toBe(true);
    expect(texts((await openingEvents(tok.vortexTech)).service_events)).toContain('dh pace work');
    const list = await request(app).get('/api/photos/by-opening/' + ids.opening).set('Authorization', tok.vortexTech);
    expect(list.body.map((p: any) => p.id)).toContain(ids.pDh);
    // Sharing is per facility: the DH Pace-only facility stays invisible to Vortex.
    expect((await request(app).get('/api/openings/' + ids.dhOpening).set('Authorization', tok.vortexTech)).status).toBe(404);
    expect((await setSharing(tok.ownerAdmin, false)).status).toBe(200);
    expect(texts((await openingEvents(tok.vortexTech)).service_events)).toEqual(texts([{ work_performed: 'vortex work' }, ...((await sql("SELECT work_performed FROM service_events WHERE work_performed='spoof attempt'")).rows)]));
  });
  it('the setting does not move or duplicate the facility', async () => {
    const r = await sql('SELECT count(*)::int AS c FROM properties WHERE id=$1', [ids.shared]);
    expect(r.rows[0].c).toBe(1);
    const owner = await sql('SELECT pf.organization_id FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id WHERE p.id=$1', [ids.shared]);
    expect(owner.rows[0].organization_id).toBe(ids.owner);
  });
});
