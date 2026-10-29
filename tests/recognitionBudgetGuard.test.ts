import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// Hosting plan step 2 (revised Oct 29 11:17): no customer budgets; usage is counted per company and
// month and only an emergency safety cap refuses (atomic), refusals recorded on the run, tracked
// downscale for originals > 5 MB, confirmed identity thresholds. Disposable in-process PGlite with
// every migration (incl. the DRAFT 090800), synthetic data, mocked storage + provider: no paid call.
const state = vi.hoisted(() => ({ db: null as any, objects: new Map<string, Uint8Array>(), engine: vi.fn() }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/legacyVision', () => ({ legacyVisionHandler: state.engine }));
vi.mock('../src/services/storage', () => ({ getObjectBytes: async (key: string, max: number) => {
  const b = state.objects.get(key); if (!b) throw new Error('object_missing'); if (b.byteLength > max) throw new Error('object_too_large'); return b; } }));
import { recognitionRunsRouter } from '../src/routes/recognitionRuns';
import { conservativeIdentity, IDENTITY_THRESHOLDS, MAX_PROVIDER_IMAGE_BYTES } from '../src/services/recognitionRuns';
import { DOWNSCALE_METHOD_VERSION, DOWNSCALE_STEPS, setImageLibraryLoaderForTests } from '../src/services/recognitionDownscale';
import sharp from 'sharp';
const app = express(); app.use(express.json()); app.use('/api/recognition/runs', recognitionRunsRouter);
const MIG = '20261030090800_recognition_budget_guard.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const tableExists = async () => (await sql("SELECT to_regclass('recognition_usage_monthly') IS NOT NULL AS e")).rows[0].e;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const jpeg = (n: number) => { const b = new Uint8Array(16); b.set([255, 216, 255, n]); return b; };
const ids: Record<string, any> = {}; const tok: Record<string, string> = {};
let rollbackProven = false, undoProven = false, big: Uint8Array;
async function org(name: string) { const id = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,$2,'customer')", [id, name]); return id; }
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
async function photo(opening: string, orgId: string, bytes: Uint8Array) {
  const id = randomUUID(), key = `private/org/${orgId}/opening/${opening}/${id}.jpg`;
  state.objects.set(key, bytes);
  await sql(`INSERT INTO photos(id,opening_id,related_entity_type,related_entity_id,storage_url,media_type,organization_id,content_type,byte_size,sha256_checksum,storage_object_key,upload_state)
    VALUES($1,$2,'opening',$2,$3,'photo',$4,'image/jpeg',$5,$6,$7,'verified')`, [id, opening, 'private:' + key, orgId, bytes.byteLength, sha(bytes), key]);
  return { id, key };
}
const good = { manufacturer: 'Example Co', series: 'S100', model: 'S100-X', visible_text: ['S100-X'], evidence: [{ observation: 'label', supports: 'model' }], confidence: { manufacturer: 0.9, series: 0.8, model: 0.7 } };
const create = (auth: string, opening: string, photoIds: string[]) => request(app).post('/api/recognition/runs').set('Authorization', auth).send({ opening_id: opening, photo_ids: photoIds, client_request_id: randomUUID() });
const month = "date_trunc('month', now())::date";
const setCap = (orgId: string, cap: number, by: string) =>
  sql("INSERT INTO recognition_safety_caps(organization_id,monthly_photo_cap,set_by_user_id,set_reason) VALUES($1,$2,$3,'synthetic emergency cap')", [orgId, cap, by]);
const reserved = async (orgId: string) => (await sql(`SELECT photos_counted FROM recognition_usage_monthly WHERE organization_id=$1 AND period_month=${month}`, [orgId])).rows[0]?.photos_counted ?? 0;

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < MIG).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const script = readFileSync('migrations/' + MIG, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;'); rollbackProven = !(await tableExists());
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  await state.db.exec(readFileSync('docs/rollback/20261030090800_recognition_budget_guard_rollback.sql', 'utf8')); undoProven = !(await tableExists());
  await state.db.exec(script); await state.db.exec(script); // idempotent re-apply
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && n > MIG).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  ids.A = await org('Synthetic company A'); ids.B = await org('Synthetic company B'); ids.N = await org('Synthetic company no budget');
  for (const k of ['A', 'B', 'N']) {
    const u = await user(ids[k], 'technician'); tok[k] = u.auth; ids[k + 'user'] = u.id;
    const f = await facility(ids[k], k); ids[k + 'open'] = f.o;
    ids[k + 'photo'] = (await photo(f.o, ids[k], jpeg(k.charCodeAt(0)))).id;
  }
  await setCap(ids.A, 2, ids.Auser); // B and N have no cap row: the default safety cap applies
  ids.Nphoto2 = (await photo(ids.Nopen, ids.N, jpeg(200))).id;
  // A real >5 MB original: random-noise JPEG at quality 100 (does not compress).
  const w = 3400, h = 2600, raw = Buffer.alloc(w * h * 3); for (let i = 0; i < raw.length; i++) raw[i] = (Math.imul(i, 2654435761) >>> 13) & 255;
  big = new Uint8Array(await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).toBuffer());
  const bp = await photo(ids.Bopen, ids.B, big); ids.bigPhoto = bp.id; ids.bigKey = bp.key;
}, 240000);
beforeEach(() => {
  state.engine.mockReset(); state.engine.mockResolvedValue({ statusCode: 200, body: JSON.stringify(good) });
  process.env.OI_RECOGNITION_ENABLED = 'true'; process.env.ANTHROPIC_API_KEY = 'test-not-real'; process.env.OI_BUILD_COMMIT = 'abc1234';
});

describe('recognition usage tracking and safety cap (DRAFT 20261030090800, not applied anywhere)', () => {
  it('migration rolls back cleanly, has a working undo script, and re-applies idempotently', () => { expect(rollbackProven).toBe(true); expect(undoProven).toBe(true); });
  it('no cap row and no budget: the run proceeds and is counted with its photo count', async () => {
    const r = await create(tok.N, ids.Nopen, [ids.Nphoto, ids.Nphoto2]);
    expect(r.status).toBe(201);
    expect(r.body.run).toMatchObject({ status: 'succeeded', photo_count: 2, usage_photo_count: 2, failure_code: null });
    expect(state.engine).toHaveBeenCalledTimes(1);
    expect(await reserved(ids.N)).toBe(2);
    expect((await sql(`SELECT runs_counted FROM recognition_usage_monthly WHERE organization_id=$1`, [ids.N])).rows[0].runs_counted).toBe(1);
    expect((await sql('SELECT default_monthly_photo_cap c, cost_per_photo_usd p, opening_price_cents_per_month o FROM recognition_usage_settings')).rows[0]).toEqual({ c: 80000, p: null, o: 75 });
  });
  it('only the emergency safety cap refuses, atomically: 5 at once against a 2-photo cap -> exactly 2 provider calls', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => create(tok.A, ids.Aopen, [ids.Aphoto])));
    expect(rs.map(r => r.body.run.status).sort()).toEqual(['refused', 'refused', 'refused', 'succeeded', 'succeeded']);
    for (const r of rs.filter(r => r.body.run.status === 'refused')) expect([r.body.run.failure_code, r.body.run.usage_photo_count]).toEqual(['safety_cap_exceeded', null]);
    for (const r of rs.filter(r => r.body.run.status === 'succeeded')) expect(r.body.run.usage_photo_count).toBe(1);
    expect(state.engine).toHaveBeenCalledTimes(2);
    expect(await reserved(ids.A)).toBe(2);
    expect((await sql('SELECT count(*)::int c FROM recognition_usage_reservations WHERE organization_id=$1', [ids.A])).rows[0].c).toBe(2);
    // A direct call to the reserve function stays refused once at the cap.
    const extra = (await sql(`INSERT INTO recognition_runs(organization_id,property_id,opening_id,requested_by_user_id,client_request_id,mode,build_commit,processing_config,started_at,photo_count)
      SELECT $1,b.property_id,o.id,$2,gen_random_uuid(),'identify','abc','{"engine":"e","model":"m","prompt_version":"p","preprocessing_version":"x"}',now(),1
      FROM openings o JOIN buildings b ON b.id=o.building_id WHERE o.id=$3 RETURNING id`, [ids.A, ids.Auser, ids.Aopen])).rows[0].id;
    await sql('INSERT INTO recognition_run_photos(run_id,photo_id,sha256_checksum,ordinal) SELECT $1,id,sha256_checksum,0 FROM photos WHERE id=$2', [extra, ids.Aphoto]);
    expect((await sql('SELECT recognition_usage_reserve($1) o', [extra])).rows[0].o).toBe('safety_cap_exceeded');
    expect(await reserved(ids.A)).toBe(2);
  });
  it('one company at its cap does not affect another company', async () => {
    const before = await reserved(ids.B);
    const r = await create(tok.B, ids.Bopen, [ids.Bphoto]);
    expect(r.body.run.status).toBe('succeeded'); expect(await reserved(ids.B)).toBe(before + 1); expect(await reserved(ids.A)).toBe(2);
  });
  it('database guards: usage is append-only and can only be counted by the reserve function', async () => {
    await expect(sql('DELETE FROM recognition_usage_reservations WHERE organization_id=$1', [ids.A])).rejects.toThrow(/append_only/);
    await expect(sql(`INSERT INTO recognition_runs(organization_id,property_id,opening_id,requested_by_user_id,client_request_id,mode,build_commit,processing_config,started_at,photo_count,usage_photo_count)
      SELECT $1,b.property_id,o.id,$2,gen_random_uuid(),'identify','abc','{"engine":"e","model":"m","prompt_version":"p","preprocessing_version":"x"}',now(),1,1
      FROM openings o JOIN buildings b ON b.id=o.building_id WHERE o.id=$3`, [ids.A, ids.Auser, ids.Aopen])).rejects.toThrow(/insert_invalid/);
    const running = (await sql("SELECT id FROM recognition_runs WHERE status='running' AND usage_photo_count IS NULL LIMIT 1")).rows[0].id;
    await expect(sql('UPDATE recognition_runs SET usage_photo_count=1 WHERE id=$1', [running])).rejects.toThrow(/immutable_fields/);
    await expect(sql("UPDATE recognition_runs SET status='refused',failure_code='budget_exceeded',finished_at=now() WHERE id=$1", [running])).rejects.toThrow(/refused_uncounted/);
    const priv = (await sql(`SELECT has_table_privilege('oi_pr2_api','recognition_usage_monthly','UPDATE') u, has_table_privilege('oi_pr2_api','recognition_safety_caps','INSERT') c,
      has_table_privilege('oi_pr2_api','recognition_usage_settings','UPDATE') s, has_function_privilege('oi_pr2_api','recognition_usage_reserve(uuid)','EXECUTE') x`)).rows[0];
    expect(priv).toEqual({ u: false, c: false, s: false, x: true });
  });
  it('originals over 5 MB: a tracked smaller copy goes to the provider; the stored original is untouched', async () => {
    expect(big.byteLength).toBeGreaterThan(MAX_PROVIDER_IMAGE_BYTES);
    const originalSha = sha(big);
    const r = await create(tok.B, ids.Bopen, [ids.bigPhoto]);
    expect(r.status).toBe(201); const run = r.body.run;
    expect(run).toMatchObject({ status: 'succeeded', downscale_used: true });
    expect(run.processing_config.preprocessing_version).toBe('stored-original-tracked-downscale-v2');
    const p = run.photos[0];
    expect(p).toMatchObject({ photo_id: ids.bigPhoto, sha256_checksum: originalSha, original_byte_size: big.byteLength, downscaled: true, downscale_method_version: DOWNSCALE_METHOD_VERSION });
    expect(p.derived_sha256_checksum).toMatch(/^[0-9a-f]{64}$/); expect(p.derived_sha256_checksum).not.toBe(originalSha);
    expect(p.derived_byte_size).toBeLessThanOrEqual(MAX_PROVIDER_IMAGE_BYTES);
    expect(DOWNSCALE_STEPS.map(s => s.max_dimension)).toContain(p.downscale_target.max_dimension);
    expect(p.downscale_target.format).toBe('jpeg'); expect(Math.max(p.derived_width, p.derived_height)).toBeLessThanOrEqual(p.downscale_target.max_dimension);
    const sent = Buffer.from(JSON.parse(state.engine.mock.calls[0][0].body).images[0], 'base64');
    expect(sha(sent)).toBe(p.derived_sha256_checksum); expect(sent.byteLength).toBe(p.derived_byte_size);
    expect(sha(state.objects.get(ids.bigKey)!)).toBe(originalSha);
    expect((await sql('SELECT sha256_checksum, byte_size FROM photos WHERE id=$1', [ids.bigPhoto])).rows[0]).toEqual({ sha256_checksum: originalSha, byte_size: big.byteLength });
    // Small originals are sent as-is and say so.
    const s = (await create(tok.B, ids.Bopen, [ids.Bphoto])).body.run;
    expect(s.downscale_used).toBe(false); expect(s.photos[0]).toMatchObject({ downscaled: false, derived_sha256_checksum: null, original_byte_size: 16 });
  }, 120000);
  it('if the image library is unavailable the run fails explicitly before any usage is counted', async () => {
    const before = await reserved(ids.B);
    setImageLibraryLoaderForTests(async () => { throw new Error('missing native module'); });
    try {
      const r = await create(tok.B, ids.Bopen, [ids.bigPhoto]);
      expect([r.body.run.status, r.body.run.failure_code, r.body.run.usage_photo_count]).toEqual(['failed', 'downscale_unavailable', null]);
    } finally { setImageLibraryLoaderForTests(async () => sharp as any); }
    expect(state.engine).not.toHaveBeenCalled(); expect(await reserved(ids.B)).toBe(before);
  }, 60000);
  it('identity thresholds are manufacturer 0.5, series 0.5, model 0.6 (+ marking and evidence)', () => {
    expect(IDENTITY_THRESHOLDS).toEqual({ manufacturer: 0.5, series: 0.5, model: 0.6 });
    const at = (m: number, s: number, mo: number, extra = {}) => conservativeIdentity({ ...good, confidence: { manufacturer: m, series: s, model: mo }, ...extra }).level;
    expect(at(0.5, 0.5, 0.6)).toBe('model'); expect(at(0.49, 0.9, 0.9)).toBe('none'); expect(at(0.5, 0.49, 0.9)).toBe('manufacturer');
    expect(at(0.5, 0.5, 0.59)).toBe('series'); expect(at(0.9, 0.9, 0.9, { visible_text: [] })).toBe('series'); expect(at(0.9, 0.9, 0.9, { evidence: [{ supports: 'series' }] })).toBe('series');
  });
});
