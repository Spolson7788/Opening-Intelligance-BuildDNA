import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ db: null as any }));
// In-process disposable SQL and mocked storage only; no hosted DB or bucket.
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/storage', () => ({
  getPresignedUploadUrl: async (key: string) => 'https://storage.invalid/' + key + '?signed=synthetic',
}));
import { facilitySchedulesRouter } from '../src/routes/facilitySchedules';
const app = express(); app.use(express.json()); app.use('/api/facility-schedules', facilitySchedulesRouter);
const migration = '20261027120000_facility_schedules.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sha = 'a'.repeat(64);
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
  rollbackProven = (await sql("SELECT to_regclass('public.facility_schedules') AS name")).rows[0].name === null;
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
}, 120000);
afterAll(async () => { await state.db?.close(); });

async function org(type = 'customer') {
  const id = randomUUID();
  await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic schedule org',$2)", [id, type]);
  return id;
}
async function user(orgId: string, role = 'admin') {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic user',$4,'not-a-real-password')", [id, orgId, id + '@example.invalid', role]);
  return { id, org: orgId, token: jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function facility() {
  const owner = await org(), admin = await user(owner), portfolio = randomUUID(), property = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio, owner]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [property, portfolio]);
  return { owner, admin, property };
}
const presign = (u: any, body: any) => request(app).post('/api/facility-schedules/presign').set('Authorization', 'Bearer ' + u.token).send(body);
const create = (u: any, body: any) => request(app).post('/api/facility-schedules').set('Authorization', 'Bearer ' + u.token).send(body);
const list = (u: any, property: string) => request(app).get('/api/facility-schedules/by-property/' + property).set('Authorization', 'Bearer ' + u.token);
async function upload(u: any, property: string, extra: any = {}) {
  const p = await presign(u, { property_id: property, kind: 'hardware', content_type: XLSX, byte_size: 1234, sha256: sha });
  if (p.status !== 200) return p;
  return create(u, { property_id: property, kind: 'hardware', title: 'Hardware schedule', original_filename: 'hw.xlsx',
    storage_key: p.body.key, content_type: XLSX, byte_size: 1234, sha256: sha, ...extra });
}
async function assign(property: string, provider: string, granter: string, active: boolean) {
  await sql(`INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id,revoked_at)
    VALUES($1,$2,$3,CASE WHEN $4 THEN NULL ELSE now() END)
    ON CONFLICT(property_id,provider_organization_id) DO UPDATE SET revoked_at=CASE WHEN $4 THEN NULL ELSE now() END`, [property, provider, granter, active]);
}

describe('facility schedules M1', () => {
  it('migration is additive and rolls back cleanly', () => { expect(rollbackProven).toBe(true); });

  it('owner admin uploads, re-versions and lists; key is facility scoped', async () => {
    const f = await facility();
    const first = await upload(f.admin, f.property);
    expect(first.status).toBe(201);
    expect(first.body.version.version).toBe(1);
    const second = await upload(f.admin, f.property, { schedule_id: first.body.schedule_id, sha256: 'b'.repeat(64) });
    expect(second.status).toBe(201);
    expect(second.body.version.version).toBe(2);
    const l = await list(f.admin, f.property);
    expect(l.status).toBe(200);
    expect(l.body).toHaveLength(1);
    expect(l.body[0].head_version).toBe(2);
    expect(l.body[0].versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(JSON.stringify(l.body)).not.toContain('storage_key');
  });

  it('role matrix: admin and facilities_manager write; technician, inspector, viewer cannot; all owner roles may list', async () => {
    const f = await facility();
    expect((await upload(await user(f.owner, 'facilities_manager'), f.property)).status).toBe(201);
    for (const role of ['technician', 'inspector', 'viewer']) {
      const u = await user(f.owner, role);
      expect((await presign(u, { property_id: f.property, kind: 'door', content_type: 'text/csv', byte_size: 10, sha256: sha })).status).toBe(403);
      expect((await create(u, { property_id: f.property, kind: 'door', title: 't', original_filename: 'd.csv',
        storage_key: `facility-schedules/${f.property}/${randomUUID()}.csv`, content_type: 'text/csv', byte_size: 10, sha256: sha })).status).toBe(403);
      expect((await list(u, f.property)).status).toBe(200);
    }
  });

  it('organization isolation: another customer cannot presign, create or list', async () => {
    const f = await facility(), other = await user(await org());
    expect((await presign(other, { property_id: f.property, kind: 'door', content_type: 'application/pdf', byte_size: 10, sha256: sha })).status).toBe(404);
    expect((await create(other, { property_id: f.property, kind: 'door', title: 't', original_filename: 'd.pdf',
      storage_key: `facility-schedules/${f.property}/${randomUUID()}.pdf`, content_type: 'application/pdf', byte_size: 10, sha256: sha })).status).toBe(404);
    expect((await list(other, f.property)).status).toBe(404);
    const theirs = await facility();
    const up = await upload(theirs.admin, theirs.property);
    expect((await upload(f.admin, f.property, { schedule_id: up.body.schedule_id })).status).toBe(404);
  });

  it('provider: denied before assignment, allowed immediately on assignment, denied after revocation', async () => {
    const f = await facility(), providerOrg = await org('service_partner'), provider = await user(providerOrg, 'admin');
    const providerTech = await user(providerOrg, 'technician');
    expect((await upload(provider, f.property)).status).toBe(404);
    expect((await list(provider, f.property)).status).toBe(404);
    await assign(f.property, providerOrg, f.admin.id, true);
    const up = await upload(provider, f.property);
    expect(up.status).toBe(201);
    const l = await list(provider, f.property);
    expect(l.status).toBe(200);
    expect(l.body[0].versions[0].uploaded_by_organization_id).toBe(providerOrg);
    expect((await list(f.admin, f.property)).body).toHaveLength(1);
    expect((await upload(providerTech, f.property)).status).toBe(403);
    const otherFacility = await facility();
    expect((await upload(provider, otherFacility.property)).status).toBe(404);
    await assign(f.property, providerOrg, f.admin.id, false);
    expect((await upload(provider, f.property)).status).toBe(404);
    expect((await list(provider, f.property)).status).toBe(404);
  });

  it('rejects out-of-scope keys, oversize files and unsupported types', async () => {
    const f = await facility(), other = await facility();
    const foreignKey = `facility-schedules/${other.property}/${randomUUID()}.xlsx`;
    expect((await create(f.admin, { property_id: f.property, kind: 'hardware', title: 't', original_filename: 'h.xlsx',
      storage_key: foreignKey, content_type: XLSX, byte_size: 10, sha256: sha })).status).toBe(400);
    expect((await presign(f.admin, { property_id: f.property, kind: 'door', content_type: XLSX, byte_size: 25 * 1024 * 1024 + 1, sha256: sha })).status).toBe(400);
    expect((await presign(f.admin, { property_id: f.property, kind: 'door', content_type: 'image/png', byte_size: 10, sha256: sha })).status).toBe(400);
    expect((await presign(f.admin, { property_id: f.property, kind: 'door', content_type: XLSX, byte_size: 10, sha256: 'xyz' })).status).toBe(400);
  });

  it('stored versions are immutable', async () => {
    const f = await facility();
    const up = await upload(f.admin, f.property);
    await expect(sql('UPDATE facility_schedule_versions SET byte_size=1 WHERE id=$1', [up.body.version.id])).rejects.toThrow(/immutable/);
    await expect(sql('DELETE FROM facility_schedule_versions WHERE id=$1', [up.body.version.id])).rejects.toThrow(/immutable/);
  });

  it('field list by opening works for technician and inspector, is 404 for another org, and inspectors cannot upload', async () => {
    const f = await facility(), building = randomUUID(), opening = randomUUID();
    await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'Synthetic building')", [building, f.property]);
    await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'door')", [opening, building]);
    await upload(f.admin, f.property);
    for (const role of ['technician', 'inspector']) {
      const u = await user(f.owner, role);
      const r = await request(app).get('/api/facility-schedules/by-opening/' + opening).set('Authorization', 'Bearer ' + u.token);
      expect(r.status).toBe(200);
      expect(r.body[0].versions[0].original_filename).toBe('hw.xlsx');
    }
    const inspector = await user(f.owner, 'inspector');
    expect((await upload(inspector, f.property)).status).toBe(403);
    const other = await user(await org());
    expect((await request(app).get('/api/facility-schedules/by-opening/' + opening).set('Authorization', 'Bearer ' + other.token)).status).toBe(404);
  });
});