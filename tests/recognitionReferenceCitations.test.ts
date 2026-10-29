import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// Reference library in recognition (DRAFT 20261030091000): with no release a run works and cites nothing;
// with an active release the provider gets only release facts, the run records reference_release_id, and
// only citations that were sent are kept. Disposable PGlite, synthetic data, mocked storage and provider.
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
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const ids: Record<string, any> = {}; const tok: Record<string, string> = {};
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
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) await state.db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  ids.oi = await org('Synthetic OI', 'internal'); ids.staff = (await user(ids.oi, 'admin')).id;
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic staff')", [ids.staff]);
  ids.owner = await org('Synthetic owner', 'customer');
  const a = await user(ids.owner, 'admin'); tok.owner = a.auth;
  const f = await facility(ids.owner, 'R-site'); ids.open = f.o;
  await sql("INSERT INTO hardware_components(opening_id,component_type,manufacturer,model_number,tracker_id) VALUES($1,'exit_device','Von Duprin','99EO','TRK-SYN1')", [ids.open]);
  ids.photo = await photo(f.o, ids.owner, jpeg(1));
}, 180000);
beforeEach(() => {
  state.engine.mockReset(); state.engine.mockResolvedValue(ok(good));
  process.env.OI_RECOGNITION_ENABLED = 'true'; process.env.ANTHROPIC_API_KEY = 'test-not-real'; process.env.OI_BUILD_COMMIT = 'abc1234';
});
const run = async () => { const r = await create(tok.owner, { opening_id: ids.open, photo_ids: [ids.photo], client_request_id: randomUUID() }); expect(r.status).toBe(201); return r.body.run; };
const S = 'e'.repeat(64);
describe('recognition with the reference library', () => {
  it('no active release: unchanged request, no release id, nothing cited', async () => {
    state.engine.mockResolvedValue(ok({ ...good, reference_citations: ['R1'] }));
    const r = await run();
    expect(r.status).toBe('succeeded');
    const sent = JSON.parse(state.engine.mock.calls[0][0].body);
    expect(sent.reference_context).toBeUndefined(); expect(sent.mode).toBe('identify');
    expect(r.reference_release_id).toBeNull(); expect(r.reference_citations).toEqual({ cited: [], rejected: [] });
    expect(r.processing_config.reference_release_version).toBeUndefined();
  });
  it('active release: only release facts are sent, the run records the release, invented citations are rejected', async () => {
    await sql(`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,licence_storage,licence_ai_processing)
      VALUES($1,'Von Duprin','Von Duprin','99 spec','spec_sheet',1,'private/reference/e.pdf','permitted','permitted')`, [S]);
    await sql("INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable) VALUES($1,1,'99EO exit only. Synthetic page.',$2,'spec','verified',true)", [S, 'f'.repeat(64)]);
    const p = randomUUID();
    await sql("INSERT INTO reference_products(id,manufacturer,series,model) VALUES($1,'Von Duprin','99','99EO')", [p]);
    await sql('INSERT INTO reference_product_sources(product_id,doc_sha256,page_no) VALUES($1,$2,1)', [p, S]);
    for (const [k, key] of [['document', S], ['product', p]]) await sql("SELECT reference_approve($1,NULL,$2,$3,'synthetic check')", [ids.staff, k, key]);
    const rel = (await sql("SELECT reference_release_publish($1,NULL,'synthetic release') r", [ids.staff])).rows[0].r;
    await sql("INSERT INTO reference_products(manufacturer,model) VALUES('Von Duprin','UNAPPROVED-9')");
    state.engine.mockResolvedValue(ok({ ...good, reference_citations: ['R1', 'R2', 'R77', 'P:invented'] }));
    const r = await run();
    const sent = JSON.parse(state.engine.mock.calls[0][0].body);
    expect(sent.reference_context).toContain('[R1] Von Duprin | series 99 | model 99EO');
    expect(sent.reference_context).toContain('99EO exit only'); expect(sent.reference_context).not.toContain('UNAPPROVED-9');
    expect(r.reference_release_id).toBe(rel.release_id);
    expect(r.reference_citations).toEqual({ cited: [{ id: 'R1', kind: 'product', source_key: p }, { id: 'R2', kind: 'page', source_key: S + ':1' }], rejected: ['R77', 'P:invented'] });
    expect(r.processing_config).toMatchObject({ reference_context_version: 'reference-context-v1', reference_release_version: 1, reference_fact_count: 2 });
  });
  it('a model reply without citations cites nothing', async () => {
    const r = await run();
    expect(r.reference_citations).toEqual({ cited: [], rejected: [] }); expect(r.reference_release_id).toBeTruthy();
  });
});
