import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// t130 hosting plan step 1: recognition run records. In-process disposable SQL, synthetic data,
// mocked storage and a mocked provider: no network, no paid call.
const state = vi.hoisted(() => ({ db: null as any, objects: new Map<string, Uint8Array>(), engine: vi.fn() }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/legacyVision', () => ({ legacyVisionHandler: state.engine }));
vi.mock('../src/services/storage', () => ({ getObjectBytes: async (key: string, max: number) => {
  const b = state.objects.get(key); if (!b) throw new Error('object_missing'); if (b.byteLength > max) throw new Error('object_too_large'); return b; } }));
import { recognitionRunsRouter } from '../src/routes/recognitionRuns';
import { conservativeIdentity, LEGACY_VISION_ENGINE_CONFIG } from '../src/services/recognitionRuns';
const app = express(); app.use(express.json()); app.use('/api/recognition/runs', recognitionRunsRouter);
const MIG = '20261030090700_recognition_runs.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const tableExists = async () => (await sql("SELECT to_regclass('recognition_runs') IS NOT NULL AS e")).rows[0].e;
const ids: Record<string, any> = {}; const tok: Record<string, string> = {};
let rollbackProven = false, undoProven = false;
const jpeg = (n: number) => { const b = new Uint8Array(16); b.set([255, 216, 255, n]); return b; };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function org(name: string, type: string) { const id = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id, name, type]); return id; }
async function user(orgId: string, role: string) {
  const id = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic',$4,'not-a-real-password')", [id, orgId, id + '@example.invalid', role]);
  return { id, auth: 'Bearer ' + jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function facility(owner: string, tag: string) {
  const pf = randomUUID(), p = randomUUID(), b = randomUUID(), o = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic')", [pf, owner]);
  await sql('INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,$3)', [p, pf, 'Synthetic ' + tag]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, p]);
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1,$2,$3,$4,'door')", [o, b, tag, 'qr-' + o]);
  return { p, o };
}
async function photo(opening: string, orgId: string, bytes: Uint8Array, state_ = 'verified', checksum = sha(bytes)) {
  const id = randomUUID(), key = `private/org/${orgId}/opening/${opening}/${id}.jpg`;
  state.objects.set(key, bytes);
  await sql(`INSERT INTO photos(id,opening_id,related_entity_type,related_entity_id,storage_url,media_type,organization_id,content_type,byte_size,sha256_checksum,storage_object_key,upload_state)
    VALUES($1,$2,'opening',$2,$3,'photo',$4,'image/jpeg',$5,$6,$7,$8)`, [id, opening, 'private:' + key, orgId, bytes.byteLength, checksum, key, state_]);
  return id;
}
const good = { manufacturer: 'Example Co', series: 'S100', model: 'S100-X', visible_text: ['S100-X'], evidence: [{ observation: 'label S100-X', supports: 'model' }], confidence: { manufacturer: 0.9, series: 0.8, model: 0.7 } };
const ok = (r: any) => ({ statusCode: 200, body: JSON.stringify(r) });
const create = (auth: string, body: any) => request(app).post('/api/recognition/runs').set('Authorization', auth).send(body);
beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < MIG).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const script = readFileSync('migrations/' + MIG, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;'); rollbackProven = !(await tableExists());
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  await state.db.exec(readFileSync('docs/rollback/20261030090700_recognition_runs_rollback.sql', 'utf8')); undoProven = !(await tableExists());
  await state.db.exec(script); await state.db.exec(script); // idempotent re-apply
  ids.owner = await org('Synthetic owner', 'customer');
  ids.V = await org('Synthetic Provider V', 'service_partner'); ids.D = await org('Synthetic Provider D', 'service_partner');
  const ownerAdmin = await user(ids.owner, 'admin'); tok.owner = ownerAdmin.auth;
  const v = await user(ids.V, 'technician'); tok.V = v.auth; ids.vUser = v.id;
  tok.D = (await user(ids.D, 'technician')).auth;
  tok.viewer = (await user(ids.owner, 'viewer')).auth;
  const fv = await facility(ids.owner, 'V-site'), fd = await facility(ids.owner, 'D-site');
  Object.assign(ids, { vProp: fv.p, vOpen: fv.o, dProp: fd.p, dOpen: fd.o });
  for (const [p, prov] of [[fv.p, ids.V], [fd.p, ids.D]]) await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [p, prov, ownerAdmin.id]);
  await sql('UPDATE properties SET share_provider_service_history=true WHERE id=$1', [fv.p]);
  ids.vPhoto = await photo(fv.o, ids.V, jpeg(1)); ids.vPhoto2 = await photo(fv.o, ids.V, jpeg(2));
  ids.dPhoto = await photo(fd.o, ids.D, jpeg(3));
  ids.reserved = await photo(fv.o, ids.V, jpeg(4), 'reserved');
  ids.tampered = await photo(fv.o, ids.V, jpeg(5), 'verified', sha(jpeg(99)));
}, 180000);
beforeEach(() => {
  state.engine.mockReset(); state.engine.mockResolvedValue(ok(good));
  process.env.OI_RECOGNITION_ENABLED = 'true'; process.env.ANTHROPIC_API_KEY = 'test-not-real'; process.env.OI_BUILD_COMMIT = 'abc1234';
});
const runCount = async () => (await sql('SELECT count(*)::int c FROM recognition_runs')).rows[0].c;
describe('recognition run records (draft migration, not applied anywhere)', () => {
  it('migration rolls back cleanly, has a working undo script, and re-applies idempotently', () => { expect(rollbackProven).toBe(true); expect(undoProven).toBe(true); });
  it('stays off by default: no run row and no provider call', async () => {
    delete process.env.OI_RECOGNITION_ENABLED; const before = await runCount();
    expect((await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() })).status).toBe(503);
    expect(state.engine).not.toHaveBeenCalled(); expect(await runCount()).toBe(before);
  });
  it('records a run linked to the stored original(s), opening, facility, org, build, config, requester and timestamps', async () => {
    const r = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto, ids.vPhoto2], client_request_id: randomUUID() });
    expect(r.status).toBe(201); const run = r.body.run;
    expect(run).toMatchObject({ status: 'succeeded', organization_id: ids.V, property_id: ids.vProp, opening_id: ids.vOpen, requested_by_user_id: ids.vUser,
      build_commit: 'abc1234', input_source: 'stored_original', result_level: 'model', manufacturer: 'Example Co', series: 'S100', model: 'S100-X', requires_technician_review: true, failure_code: null });
    expect(run.photos).toEqual([{ photo_id: ids.vPhoto, sha256_checksum: sha(jpeg(1)) }, { photo_id: ids.vPhoto2, sha256_checksum: sha(jpeg(2)) }]);
    expect(run.processing_config).toMatchObject({ engine: 'legacyVision', model: LEGACY_VISION_ENGINE_CONFIG.model, prompt_version: LEGACY_VISION_ENGINE_CONFIG.prompt_version, preprocessing_version: 'stored-original-none-v1' });
    expect(run.requested_at && run.started_at && run.finished_at).toBeTruthy();
    // The provider received the stored original bytes, not client-sent base64.
    const sent = JSON.parse(state.engine.mock.calls[0][0].body);
    expect(sent.images).toEqual([Buffer.from(jpeg(1)).toString('base64'), Buffer.from(jpeg(2)).toString('base64')]);
    expect(state.engine).toHaveBeenCalledTimes(1);
  });
  it('keeps the result conservative: drops unsupported levels and abstains when nothing is supported', async () => {
    state.engine.mockResolvedValue(ok({ ...good, confidence: { manufacturer: 0.9, series: 0.8, model: 0.4 } }));
    let run = (await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() })).body.run;
    expect([run.result_level, run.series, run.model]).toEqual(['series', 'S100', null]);
    state.engine.mockResolvedValue(ok({ manufacturer: null, series: 'S100', model: 'S100-X', confidence: { manufacturer: null, series: 0.9, model: 0.9 } }));
    run = (await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() })).body.run;
    expect([run.status, run.result_level, run.manufacturer, run.series, run.model]).toEqual(['abstained', 'none', null, null, null]);
    expect(conservativeIdentity({ ...good, visible_text: [] }).level).toBe('series');
    expect(conservativeIdentity({ ...good, evidence: [] }).level).toBe('series');
  });
  it('records explicit failures and never retries the provider', async () => {
    state.engine.mockResolvedValue({ statusCode: 502, body: JSON.stringify({ error: 'sensitive upstream detail' }) });
    let r = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() });
    expect([r.body.run.status, r.body.run.failure_code]).toEqual(['failed', 'provider_failed']); expect(r.text).not.toContain('sensitive');
    expect(state.engine).toHaveBeenCalledTimes(1);
    state.engine.mockReset(); state.engine.mockResolvedValue({ statusCode: 500, body: '{"error":"timeout"}' });
    r = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() });
    expect([r.body.run.status, r.body.run.failure_code]).toEqual(['ambiguous', 'provider_call_outcome_unknown']); expect(state.engine).toHaveBeenCalledTimes(1);
    state.engine.mockReset(); state.engine.mockRejectedValue(new Error('socket hang up'));
    r = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() });
    expect(r.body.run.status).toBe('ambiguous'); expect(state.engine).toHaveBeenCalledTimes(1);
    state.engine.mockReset(); state.engine.mockResolvedValue({ statusCode: 200, body: 'not json' });
    r = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() });
    expect([r.body.run.status, r.body.run.failure_code]).toEqual(['failed', 'provider_result_unreadable']);
  });
  it('fails explicitly, without a provider call, when the stored original does not match its checksum or is missing', async () => {
    let r = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.tampered], client_request_id: randomUUID() });
    expect([r.body.run.status, r.body.run.failure_code]).toEqual(['failed', 'stored_original_checksum_mismatch']);
    const key = (await sql('SELECT storage_object_key k FROM photos WHERE id=$1', [ids.vPhoto2])).rows[0].k; const saved = state.objects.get(key)!; state.objects.delete(key);
    r = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto2], client_request_id: randomUUID() });
    expect([r.body.run.status, r.body.run.failure_code]).toEqual(['failed', 'stored_original_unreadable']); state.objects.set(key, saved);
    expect(state.engine).not.toHaveBeenCalled();
    expect((await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.reserved], client_request_id: randomUUID() })).status).toBe(404);
  });
  it('a replayed request returns the same run with no second call; a new request id re-runs the same photo on purpose', async () => {
    const crid = randomUUID();
    const a = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: crid });
    const b = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: crid });
    expect(b.status).toBe(200); expect(b.body.replayed).toBe(true); expect(b.body.run.id).toBe(a.body.run.id); expect(state.engine).toHaveBeenCalledTimes(1);
    const c = await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID(), repeat_of_run_id: a.body.run.id });
    expect(c.status).toBe(201); expect(c.body.run.id).not.toBe(a.body.run.id); expect(c.body.run.repeat_of_run_id).toBe(a.body.run.id);
    // No global checksum uniqueness: many runs share one photo checksum.
    expect((await sql('SELECT count(*)::int c FROM recognition_run_photos WHERE sha256_checksum=$1', [sha(jpeg(1))])).rows[0].c).toBeGreaterThan(3);
  });
  it('org/provider access: D cannot run on or read V runs (even with sharing on); owner can read; viewer denied', async () => {
    const run = (await create(tok.V, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() })).body.run;
    state.engine.mockClear();
    expect((await create(tok.D, { opening_id: ids.vOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() })).status).toBe(404);
    expect((await create(tok.D, { opening_id: ids.dOpen, photo_ids: [ids.vPhoto], client_request_id: randomUUID() })).status).toBe(404);
    expect(state.engine).not.toHaveBeenCalled();
    expect((await request(app).get('/api/recognition/runs/' + run.id).set('Authorization', tok.D)).status).toBe(404);
    expect((await request(app).get('/api/recognition/runs?opening_id=' + ids.vOpen).set('Authorization', tok.D)).body.runs ?? []).toEqual([]);
    expect((await request(app).get('/api/recognition/runs/' + run.id).set('Authorization', tok.owner)).status).toBe(200);
    expect((await request(app).get('/api/recognition/runs/' + run.id).set('Authorization', tok.V)).status).toBe(200);
    expect((await request(app).get('/api/recognition/runs/' + run.id).set('Authorization', tok.viewer)).status).toBe(403);
    expect((await request(app).get('/api/recognition/runs/' + run.id)).status).toBe(401);
    // After revocation V can no longer read its own runs on that facility.
    await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [ids.vProp, ids.V]);
    expect((await request(app).get('/api/recognition/runs/' + run.id).set('Authorization', tok.V)).status).toBe(404);
    await sql('UPDATE facility_provider_assignments SET revoked_at=NULL WHERE property_id=$1 AND provider_organization_id=$2', [ids.vProp, ids.V]);
  });
  it('database guards: no delete, finished runs frozen, failure must carry a code, partial identities rejected', async () => {
    const id = (await sql("SELECT id FROM recognition_runs WHERE status='succeeded' LIMIT 1")).rows[0].id;
    await expect(sql('DELETE FROM recognition_runs WHERE id=$1', [id])).rejects.toThrow(/recognition_runs_no_delete/);
    await expect(sql("UPDATE recognition_runs SET model='other' WHERE id=$1", [id])).rejects.toThrow(/finished_is_immutable/);
    await expect(sql('DELETE FROM recognition_run_photos WHERE run_id=$1', [id])).rejects.toThrow(/append_only/);
    const base = [ids.V, ids.vProp, ids.vOpen, ids.vUser];
    const ins = (extra: string) => sql(`INSERT INTO recognition_runs(organization_id,property_id,opening_id,requested_by_user_id,client_request_id,mode,build_commit,processing_config,started_at,${extra.split('|')[0]})
      VALUES($1,$2,$3,$4,gen_random_uuid(),'identify','abc','{"engine":"e","model":"m","prompt_version":"p","preprocessing_version":"x"}',now(),${extra.split('|')[1]})`, base);
    await expect(ins("status,finished_at|'failed',now()")).rejects.toThrow(/failure_explicit/);
    await expect(ins("status,finished_at,result_level,model|'succeeded',now(),'model','M'")).rejects.toThrow(/level_consistent/);
    expect(readFileSync('src/services/legacyVision.ts', 'utf8')).toContain(`model: "${LEGACY_VISION_ENGINE_CONFIG.model}"`);
    expect(readFileSync('src/services/legacyVision.ts', 'utf8')).toContain('source SHA256 9da330e98a2f1646');
  });
});
