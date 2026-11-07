import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// Recognition run records (Oct 31 2026 milestone, DRAFT 20261031090000, not applied anywhere):
// one record per photo per attempt incl. failures and safety-cap refusals; thresholds 0.5 / 0.5 /
// 0.6 + marking; RLS (company members, revoked providers lose access, OI staff see all); monthly
// staff report. Disposable in-process PGlite, every migration, mocked storage + provider (no paid
// call), synthetic data only.
const state = vi.hoisted(() => ({ db: null as any, objects: new Map<string, Uint8Array>(), engine: vi.fn() }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
vi.mock('../src/services/legacyVision', () => ({ legacyVisionHandler: state.engine }));
vi.mock('../src/services/storage', async (orig) => ({ ...(await orig<any>()), getObjectBytes: async (key: string, max: number) => {
  const b = state.objects.get(key); if (!b) throw new Error('object_missing'); if (b.byteLength > max) throw new Error('object_too_large'); return b; } }));
import { createApp } from '../src/app';
import { matchedLevels, recordStatus, RECORD_WRITE_RETRY } from '../src/services/recognitionRunRecords';
import { conservativeIdentity } from '../src/services/recognitionRuns';
import { flushAccessDenialWrites } from '../src/middleware/recognitionAccessDenials';
const app = createApp();
const MIG = '20261031090000_recognition_run_records.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const exists = async () => (await sql("SELECT to_regclass('recognition_run_records') IS NOT NULL AS e")).rows[0].e;
const id: Record<string, string> = {}; const tok: Record<string, string> = {};
let rollbackProven = false, undoProven = false, n = 0;
async function photo(opening: string, orgKey: string, stored = true) {
  const pid = randomUUID(), key = `private/org/${id[orgKey]}/opening/${opening}/${pid}.jpg`, bytes = new Uint8Array(16); bytes.set([255, 216, 255, ++n]);
  if (stored) state.objects.set(key, bytes);
  await sql(`INSERT INTO photos(id,opening_id,related_entity_type,related_entity_id,storage_url,media_type,organization_id,content_type,byte_size,sha256_checksum,storage_object_key,upload_state)
    VALUES($1,$2,'opening',$2,$3,'photo',$4,'image/jpeg',16,$5,$6,'verified')`, [pid, opening, 'private:' + key, id[orgKey], sha(bytes), key]);
  return pid;
}
const run = (who: string, opening: string, photos: string[]) => request(app).post('/api/recognition/runs').set('Authorization', tok[who])
  .send({ opening_id: opening, photo_ids: photos, client_request_id: randomUUID() });
const records = async (runId: string) => (await sql('SELECT * FROM recognition_run_records WHERE run_id=$1 ORDER BY photo_id', [runId])).rows;
const full = { manufacturer: 'Example Co', series: 'S100', model: 'S100-X', visible_text: ['S100-X'], evidence: [{ observation: 'label', supports: 'model' }], confidence: { manufacturer: 0.9, series: 0.8, model: 0.7 } };
const reply = (body: unknown, statusCode = 200) => state.engine.mockResolvedValueOnce({ statusCode, body: JSON.stringify(body) });
// Read as the API role (RLS applies) with the acting user set for the transaction.
async function asActor<T = any>(actor: string | null, q: string, a?: unknown[]): Promise<T[]> {
  return state.db.transaction(async (tx: any) => {
    await tx.query('SET LOCAL ROLE oi_pr2_api');
    if (actor) await tx.query("SELECT set_config('oi.actor_user_id', $1, true)", [actor]);
    return (await tx.query(q, a)).rows;
  });
}
const visibleOrgs = async (actor: string | null) => (await asActor(actor, 'SELECT DISTINCT organization_id FROM recognition_run_records')).map((r: any) => r.organization_id).sort();

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'synthetic-test-secret';
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  // Like Supabase: default privileges grant new sequences to anon/authenticated; the migration must revoke them.
  await state.db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;');
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql') && f < MIG).sort()) await state.db.exec(fix(readFileSync('migrations/' + f, 'utf8')));
  const script = readFileSync('migrations/' + MIG, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;'); rollbackProven = !(await exists());
  await state.db.exec(script);
  await state.db.exec(readFileSync('docs/rollback/20261031090000_recognition_run_records_rollback.sql', 'utf8')); undoProven = !(await exists());
  await state.db.exec(script); await state.db.exec(script); // idempotent re-apply
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql') && f > MIG).sort()) await state.db.exec(fix(readFileSync('migrations/' + f, 'utf8')));
  for (const [k, t] of [['oi', 'internal'], ['cust', 'customer'], ['prov', 'service_partner'], ['other', 'customer']]) {
    id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], 'Synthetic ' + k, t]);
    id[k + 'User'] = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-password')", [id[k + 'User'], id[k], id[k + 'User'] + '@example.invalid']);
    tok[k] = 'Bearer ' + jwt.sign({ userId: id[k + 'User'], organizationId: id[k], role: 'admin', sessionVersion: 0, ...(k === 'oi' ? { mfaVerified: true } : {}) }, process.env.JWT_SECRET!);
  }
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic staff')", [id.oiUser]);
  for (const k of ['cust', 'other']) {
    const pf = randomUUID(), p = randomUUID(), b = randomUUID(), o = randomUUID();
    await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic')", [pf, id[k]]);
    await sql('INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,$3)', [p, pf, 'Synthetic facility ' + k]);
    await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, p]);
    await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,status) VALUES($1,$2,$3,$4,'door','active')", [o, b, 'D-' + k, 'qr-' + o]);
    id[k + 'Prop'] = p; id[k + 'Open'] = o;
  }
  await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [id.custProp, id.prov, id.custUser]);
  await sql("UPDATE recognition_usage_settings SET cost_per_photo_usd=0.0125 WHERE id");
  await sql("INSERT INTO recognition_safety_caps(organization_id,monthly_photo_cap,set_by_user_id,set_reason) VALUES($1,1,$2,'synthetic emergency cap')", [id.prov, id.oiUser]);
}, 240000);
beforeEach(() => {
  state.engine.mockReset(); state.engine.mockResolvedValue({ statusCode: 200, body: JSON.stringify(full) });
  process.env.OI_RECOGNITION_ENABLED = 'true'; process.env.ANTHROPIC_API_KEY = 'test-not-real'; process.env.OI_BUILD_COMMIT = 'abc1234';
});

describe('recognition run records (DRAFT 20261031090000, not applied anywhere)', () => {
  it('migration rolls back cleanly, has a working undo script, and re-applies idempotently', () => { expect(rollbackProven).toBe(true); expect(undoProven).toBe(true); });

  it('maps run outcomes and keeps only levels that pass 0.5 / 0.5 / 0.6 + marking, with their scores', () => {
    expect(['succeeded', 'abstained', 'refused', 'failed', 'ambiguous'].map(recordStatus)).toEqual(['succeeded', 'succeeded', 'blocked_by_cap', 'failed', 'failed']);
    expect(matchedLevels(full, conservativeIdentity(full))).toEqual({ manufacturer: 'Example Co', manufacturer_confidence: 0.9, series: 'S100', series_confidence: 0.8,
      model: 'S100-X', model_confidence: 0.7, model_marking_evidence: true });
    const noMarking = { ...full, visible_text: [] };
    expect(matchedLevels(noMarking, conservativeIdentity(noMarking))).toMatchObject({ series: 'S100', model: null, model_confidence: null, model_marking_evidence: false });
    const low = { ...full, confidence: { manufacturer: 0.5, series: 0.49, model: 0.99 } };
    expect(matchedLevels(low, conservativeIdentity(low))).toMatchObject({ manufacturer: 'Example Co', manufacturer_confidence: 0.5, series: null, model: null });
  });

  it('a successful run writes one record per photo with company, facility, opening, match, scores and cost', async () => {
    const p1 = await photo(id.custOpen, 'cust'), p2 = await photo(id.custOpen, 'cust');
    const r = await run('cust', id.custOpen, [p1, p2]);
    expect(r.status).toBe(201);
    const rows = await records(r.body.run.id);
    expect(rows.map((x: any) => x.photo_id).sort()).toEqual([p1, p2].sort());
    for (const x of rows) expect(x).toMatchObject({ organization_id: id.cust, property_id: id.custProp, opening_id: id.custOpen, status: 'succeeded', failure_code: null,
      manufacturer: 'Example Co', series: 'S100', model: 'S100-X', model_marking_evidence: true, provider_called: true });
    expect(rows.map((x: any) => [Number(x.manufacturer_confidence), Number(x.series_confidence), Number(x.model_confidence), Number(x.cost_per_photo_usd)])[0]).toEqual([0.9, 0.8, 0.7, 0.0125]);
    expect(rows[0].recorded_at).toBeInstanceOf(Date);
  });

  it('below-threshold answers are recorded as succeeded attempts with no (or partial) match', async () => {
    reply({ manufacturer: 'Example Co', confidence: { manufacturer: 0.49 } });
    const r = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust')]);
    expect(r.body.run.status).toBe('abstained');
    expect((await records(r.body.run.id))[0]).toMatchObject({ status: 'succeeded', manufacturer: null, manufacturer_confidence: null, series: null, model: null, provider_called: true });
    reply({ ...full, confidence: { manufacturer: 0.9, series: 0.8, model: 0.59 } });
    const s = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust')]);
    expect((await records(s.body.run.id))[0]).toMatchObject({ status: 'succeeded', series: 'S100', model: null, model_confidence: null });
  });

  it('failures are recorded: unreadable original (no provider call) and unknown provider outcome (called)', async () => {
    const missing = await photo(id.custOpen, 'cust', false);
    const r = await run('cust', id.custOpen, [missing]);
    expect(r.body.run).toMatchObject({ status: 'failed', failure_code: 'stored_original_unreadable' });
    expect(state.engine).not.toHaveBeenCalled();
    expect(await records(r.body.run.id)).toMatchObject([{ status: 'failed', failure_code: 'stored_original_unreadable', provider_called: false, manufacturer: null }]);
    reply({ error: 'x' }, 500);
    const a = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust')]);
    expect(a.body.run.status).toBe('ambiguous');
    expect(await records(a.body.run.id)).toMatchObject([{ status: 'failed', failure_code: 'provider_call_outcome_unknown', provider_called: true }]);
  });

  it('attempts blocked by the atomic emergency cap are recorded as blocked_by_cap without a provider call', async () => {
    const ok = await run('prov', id.custOpen, [await photo(id.custOpen, 'prov')]);
    expect(ok.body.run.status).toBe('succeeded');
    const blocked = await run('prov', id.custOpen, [await photo(id.custOpen, 'prov')]);
    expect(blocked.body.run).toMatchObject({ status: 'refused', failure_code: 'safety_cap_exceeded' });
    expect(state.engine).toHaveBeenCalledTimes(1);
    expect(await records(blocked.body.run.id)).toMatchObject([{ organization_id: id.prov, status: 'blocked_by_cap', failure_code: 'safety_cap_exceeded', provider_called: false, manufacturer: null }]);
  });

  it('every attempt that created a run has records; a replay adds only its own replayed row', async () => {
    const orphans = (await sql('SELECT count(*)::int c FROM recognition_runs r WHERE NOT EXISTS (SELECT 1 FROM recognition_run_records x WHERE x.run_id=r.id)')).rows[0].c;
    expect(orphans).toBe(0);
    const body = { opening_id: id.custOpen, photo_ids: [await photo(id.custOpen, 'cust')], client_request_id: randomUUID() };
    const first = await request(app).post('/api/recognition/runs').set('Authorization', tok.cust).send(body);
    const before = (await sql('SELECT count(*)::int c FROM recognition_run_records')).rows[0].c;
    const again = await request(app).post('/api/recognition/runs').set('Authorization', tok.cust).send(body);
    expect(again.body.replayed).toBe(true); expect(again.body.run.id).toBe(first.body.run.id);
    expect((await sql('SELECT count(*)::int c FROM recognition_run_records')).rows[0].c).toBe(before + 1);
    expect((await sql("SELECT count(*)::int c FROM recognition_run_records WHERE run_id=$1 AND status<>'replayed'", [first.body.run.id])).rows[0].c).toBe(1);
  });

  it('database guards: append-only, thresholds and status rules enforced', async () => {
    const any = (await sql('SELECT * FROM recognition_run_records LIMIT 1')).rows[0];
    await expect(sql('DELETE FROM recognition_run_records WHERE id=$1', [any.id])).rejects.toThrow(/append_only/);
    await expect(sql("UPDATE recognition_run_records SET status='failed' WHERE id=$1", [any.id])).rejects.toThrow(/append_only/);
    const p = await photo(id.custOpen, 'cust');
    const runId = randomUUID();
    await sql(`INSERT INTO recognition_runs(id,organization_id,property_id,opening_id,requested_by_user_id,client_request_id,mode,build_commit,processing_config,started_at,photo_count)
      VALUES($1,$2,$3,$4,$5,gen_random_uuid(),'identify','abc','{"engine":"e","model":"m","prompt_version":"p","preprocessing_version":"x"}',now(),1)`, [runId, id.cust, id.custProp, id.custOpen, id.custUser]);
    const raw = (status: string, code: string | null, called: boolean, m: unknown[], run: string | null = runId) => sql(`INSERT INTO recognition_run_records(attempt_id,run_id,organization_id,property_id,opening_id,photo_id,status,failure_code,provider_called,
      manufacturer,manufacturer_confidence,series,series_confidence,model,model_confidence,model_marking_evidence,requested_by_user_id) VALUES($16,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$17)`,
      [run, id.cust, id.custProp, id.custOpen, p, status, code, called, ...m, run ?? randomUUID(), id.custUser]);
    const none = [null, null, null, null, null, null, false];
    await expect(raw('succeeded', null, true, ['M', 0.9, 'S', 0.9, 'X', 0.59, true])).rejects.toThrow(/thresholds/);
    await expect(raw('succeeded', null, true, ['M', 0.9, 'S', 0.9, 'X', 0.7, false])).rejects.toThrow(/thresholds/);
    await expect(raw('succeeded', null, true, ['M', 0.49, null, null, null, null, false])).rejects.toThrow(/thresholds/);
    await expect(raw('succeeded', null, true, [null, null, 'S', 0.9, null, null, false])).rejects.toThrow(/hierarchy/);
    await expect(raw('blocked_by_cap', 'safety_cap_exceeded', true, none)).rejects.toThrow(/blocked/);
    await expect(raw('failed', null, false, none)).rejects.toThrow(/failure_explicit/);
    await expect(raw('failed', 'provider_failed', true, ['M', 0.9, null, null, null, null, false])).rejects.toThrow(/match_only_on_success/);
    await expect(raw('succeeded', null, false, none)).rejects.toThrow(/success_called/);
    await expect(raw('rejected', 'opening_not_found', false, none)).rejects.toThrow(/rejected_no_run/);
    await expect(raw('failed', 'provider_failed', false, none, null)).rejects.toThrow(/rejected_no_run/);
    await expect(raw('rejected', 'opening_not_found', false, none, null)).rejects.toThrow(/rejected_shape/); // a rejected row has no photo
  });

  it('RLS: OI staff see all; owner members see their facility; providers see their own only while assigned; others nothing', async () => {
    expect(await visibleOrgs(id.oiUser)).toEqual([id.cust, id.prov].sort());
    expect(await visibleOrgs(id.custUser)).toEqual([id.cust, id.prov].sort());
    expect(await visibleOrgs(id.provUser)).toEqual([id.prov]);
    expect(await visibleOrgs(id.otherUser)).toEqual([]);
    expect(await visibleOrgs(null)).toEqual([]);
    expect(await asActor('not-a-uuid', 'SELECT count(*)::int c FROM recognition_run_records')).toEqual([{ c: 0 }]);
    // The API role can insert but never update or delete.
    const priv = (await sql(`SELECT has_table_privilege('oi_pr2_api','recognition_run_records','INSERT') i, has_table_privilege('oi_pr2_api','recognition_run_records','UPDATE') u,
      has_table_privilege('oi_pr2_api','recognition_run_records','DELETE') d, has_table_privilege('anon','recognition_run_records','SELECT') a,
      has_table_privilege('authenticated','recognition_run_records_monthly','SELECT') v,
      has_function_privilege('anon','recognition_run_record_visible(uuid,uuid)','EXECUTE') fa, has_function_privilege('authenticated','recognition_run_records_guard()','EXECUTE') fg`)).rows[0];
    expect(priv).toEqual({ i: true, u: false, d: false, a: false, v: false, fa: false, fg: false });
  });

  it('RLS: a revoked provider loses access to its past records; the owner and OI staff keep them', async () => {
    await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [id.custProp, id.prov]);
    expect(await visibleOrgs(id.provUser)).toEqual([]);
    expect(await visibleOrgs(id.custUser)).toEqual([id.cust, id.prov].sort());
    expect(await visibleOrgs(id.oiUser)).toEqual([id.cust, id.prov].sort());
    // A deactivated owner member loses access too.
    await sql('UPDATE users SET is_active=false WHERE id=$1', [id.custUser]);
    expect(await visibleOrgs(id.custUser)).toEqual([]);
    await sql('UPDATE users SET is_active=true WHERE id=$1', [id.custUser]);
  });

  it('monthly view by company and month: correct counts and cost; RLS-scoped for non-staff readers', async () => {
    const month = (await sql("SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'),'YYYY-MM-01') m")).rows[0].m;
    const staff = await asActor(id.oiUser, 'SELECT * FROM recognition_run_records_monthly WHERE period_month=$1::date ORDER BY organization_id', [month]);
    const prov = staff.find((r: any) => r.organization_id === id.prov);
    expect(prov).toMatchObject({ runs: 2, photo_attempts: 2, succeeded_photos: 1, blocked_by_cap_photos: 1, failed_photos: 0, provider_photos: 1, model_matches: 1 });
    expect(Number(prov.oi_cost_usd)).toBe(0.0125);
    const cust = staff.find((r: any) => r.organization_id === id.cust);
    const direct = (await sql("SELECT count(*)::int c, count(*) FILTER (WHERE provider_called)::int p, count(*) FILTER (WHERE status='failed')::int f FROM recognition_run_records WHERE organization_id=$1 AND status NOT IN ('rejected','replayed')", [id.cust])).rows[0];
    expect([cust.photo_attempts, cust.provider_photos, cust.failed_photos]).toEqual([direct.c, direct.p, direct.f]);
    expect(Number(cust.oi_cost_usd)).toBeCloseTo(direct.p * 0.0125, 6);
    expect(await asActor(id.otherUser, 'SELECT * FROM recognition_run_records_monthly')).toEqual([]);
  });

  it('staff endpoint: OI staff only, validates the month, returns rows by company and month', async () => {
    const m = new Date().toISOString().slice(0, 7);
    const r = await request(app).get('/api/platform/recognition-run-records/monthly?month=' + m).set('Authorization', tok.oi);
    expect(r.status).toBe(200); expect(r.body.month).toBe(m);
    expect(r.body.rows.map((x: any) => x.organization_id).sort()).toEqual([id.cust, id.prov].sort());
    expect(r.body.rows.every((x: any) => x.period_month === m && typeof x.oi_cost_usd === 'number' && x.organization_name.startsWith('Synthetic'))).toBe(true);
    const all = await request(app).get('/api/platform/recognition-run-records/monthly').set('Authorization', tok.oi);
    expect(all.status).toBe(200); expect(all.body.month).toBe(null); expect(all.body.rows.length).toBe(2);
    expect((await request(app).get('/api/platform/recognition-run-records/monthly?month=2026-13').set('Authorization', tok.oi)).status).toBe(400);
    for (const who of ['cust', 'prov', 'other']) expect((await request(app).get('/api/platform/recognition-run-records/monthly').set('Authorization', tok[who])).status).toBe(403);
    expect((await request(app).get('/api/platform/recognition-run-records/monthly')).status).toBe(401);
  });
});
describe('follow-ups (Oct 31 10:28): rejected attempts, retries + outbox, mid-run errors', () => {
  beforeAll(async () => {
    RECORD_WRITE_RETRY.delaysMs = [1, 1, 1];
    // Test-only failure injection: the next N inserts into a table fail (sequence survives the abort).
    await state.db.exec(`CREATE SEQUENCE t_fail_seq; CREATE TABLE t_fail(tbl text PRIMARY KEY, max_fail int NOT NULL);
      CREATE FUNCTION t_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS (SELECT 1 FROM t_fail WHERE tbl = TG_TABLE_NAME AND max_fail > 0) AND nextval('t_fail_seq') <= (SELECT max_fail FROM t_fail WHERE tbl = TG_TABLE_NAME)
        THEN RAISE EXCEPTION 'synthetic_write_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER t_fail BEFORE INSERT ON recognition_run_records FOR EACH ROW EXECUTE FUNCTION t_fail_fn();
      CREATE TRIGGER t_fail BEFORE INSERT ON recognition_run_photos FOR EACH ROW EXECUTE FUNCTION t_fail_fn();`);
  });
  const failNext = async (tbl: string, n: number) => { await sql("SELECT setval('t_fail_seq', 1, false)"); await sql('INSERT INTO t_fail VALUES($1,$2) ON CONFLICT (tbl) DO UPDATE SET max_fail=EXCLUDED.max_fail', [tbl, n]); };
  const rejected = async (orgId: string) => (await sql("SELECT * FROM recognition_run_records WHERE status='rejected' AND organization_id=$1 ORDER BY recorded_at", [orgId])).rows;

  it('attempts refused before a run are recorded as rejected with the reason; opening only when reachable', async () => {
    const before = (await rejected(id.cust)).length;
    const bad = await request(app).post('/api/recognition/runs').set('Authorization', tok.cust).send({ opening_id: 'nope' });
    expect(bad.status).toBe(400);
    process.env.OI_RECOGNITION_ENABLED = 'false';
    const off = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust')]);
    expect(off.status).toBe(503);
    process.env.OI_RECOGNITION_ENABLED = 'true';
    const missing = await run('cust', id.custOpen, [randomUUID()]);
    expect(missing.body.error).toBe('stored_original_not_found');
    const rows = (await rejected(id.cust)).slice(before);
    expect(rows.map((r: any) => [r.failure_code, r.opening_id, r.property_id, r.run_id, r.photo_id, r.provider_called, r.requested_by_user_id])).toEqual([
      ['invalid_recognition_run_request', null, null, null, null, false, id.custUser],
      ['recognition_unavailable', id.custOpen, id.custProp, null, null, false, id.custUser],
      ['stored_original_not_found', id.custOpen, id.custProp, null, null, false, id.custUser]]);
    expect(state.engine).not.toHaveBeenCalled();
    // Another company probing the customer's opening: recorded for that company, without the opening.
    const probe = await run('other', id.custOpen, [randomUUID()]);
    expect(probe.status).toBe(404);
    expect(await rejected(id.other)).toMatchObject([{ failure_code: 'opening_not_found', opening_id: null, property_id: null }]);
  });

  it('RLS for rejected rows: own company (and staff) only; never the facility owner for an unresolved opening', async () => {
    const otherRows = await asActor(id.otherUser, "SELECT failure_code FROM recognition_run_records WHERE status='rejected'");
    expect(otherRows).toEqual([{ failure_code: 'opening_not_found' }]);
    const custSees = await asActor(id.custUser, "SELECT organization_id FROM recognition_run_records WHERE status='rejected'");
    expect(custSees.every((r: any) => r.organization_id === id.cust)).toBe(true);
    expect((await asActor(id.oiUser, "SELECT DISTINCT organization_id FROM recognition_run_records WHERE status='rejected'")).length).toBe(2);
    const m = await asActor(id.oiUser, 'SELECT rejected_attempts FROM recognition_run_records_monthly WHERE organization_id=$1', [id.other]);
    expect(m).toEqual([{ rejected_attempts: 1 }]);
  });

  it('a failing record write is retried with backoff and then succeeds', async () => {
    await failNext('recognition_run_records', 2);
    const r = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust')]);
    expect(r.status).toBe(201);
    expect(await records(r.body.run.id)).toMatchObject([{ status: 'succeeded', model: 'S100-X' }]);
    expect((await sql('SELECT count(*)::int n FROM recognition_run_record_outbox')).rows[0].n).toBe(0);
  });

  it('when retries are exhausted the record goes to the outbox and staff reprocessing writes it exactly once', async () => {
    await failNext('recognition_run_records', 1000);
    const r = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust'), await photo(id.custOpen, 'cust')]);
    expect(r.status).toBe(201); expect(r.body.run.status).toBe('succeeded'); // the caller's outcome is unchanged
    expect(await records(r.body.run.id)).toEqual([]);
    const box = (await sql('SELECT * FROM recognition_run_record_outbox')).rows;
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ attempt_id: r.body.run.id, processed_at: null, attempts: 0 });
    expect(box[0].first_error).toMatch(/synthetic_write_failure/);
    expect(Number(box[0].cost_per_photo_usd)).toBe(0.0125);
    expect((await request(app).get('/api/platform/recognition-run-records/outbox').set('Authorization', tok.oi)).body).toMatchObject({ pending: 1, processed: 0 });
    // Still failing: reprocess keeps it pending and counts the attempt.
    expect((await request(app).post('/api/platform/recognition-run-records/outbox/reprocess').set('Authorization', tok.oi).send({})).body).toEqual({ processed: 0, failed: 1, pending: 1 });
    await failNext('recognition_run_records', 0);
    for (const who of ['cust', 'prov']) expect((await request(app).post('/api/platform/recognition-run-records/outbox/reprocess').set('Authorization', tok[who]).send({})).status).toBe(403);
    expect((await request(app).post('/api/platform/recognition-run-records/outbox/reprocess').set('Authorization', tok.oi).send({ limit: 0 })).status).toBe(400);
    const ok = await request(app).post('/api/platform/recognition-run-records/outbox/reprocess').set('Authorization', tok.oi).send({ limit: 10 });
    expect(ok.body).toEqual({ processed: 1, failed: 0, pending: 0 });
    const rows = await records(r.body.run.id);
    expect(rows).toHaveLength(2);
    for (const x of rows) expect([x.status, Number(x.cost_per_photo_usd), new Date(x.recorded_at) < new Date(box[0].created_at)]).toEqual(['succeeded', 0.0125, true]);
    expect((await request(app).post('/api/platform/recognition-run-records/outbox/reprocess').set('Authorization', tok.oi).send({})).body).toEqual({ processed: 0, failed: 0, pending: 0 });
    expect(await records(r.body.run.id)).toHaveLength(2);
    const kept = (await sql('SELECT attempts, processed_at FROM recognition_run_record_outbox')).rows[0];
    expect(kept.attempts).toBe(2); expect(kept.processed_at).toBeInstanceOf(Date);
    await expect(sql('DELETE FROM recognition_run_record_outbox')).rejects.toThrow(/no_delete/);
    await expect(sql('UPDATE recognition_run_record_outbox SET last_error=NULL')).rejects.toThrow(/immutable/);
    const priv = (await sql(`SELECT has_table_privilege('anon','recognition_run_record_outbox','SELECT') a, has_table_privilege('oi_pr2_api','recognition_run_record_outbox','DELETE') d`)).rows[0];
    expect(priv).toEqual({ a: false, d: false });
    const seq = (await sql(`SELECT has_sequence_privilege('anon','recognition_run_record_outbox_id_seq','USAGE') a, has_sequence_privilege('authenticated','recognition_run_record_outbox_id_seq','UPDATE') b,
      has_sequence_privilege('oi_pr2_api','recognition_run_record_outbox_id_seq','USAGE') api,
      (SELECT relacl::text FROM pg_class WHERE relname='recognition_run_record_outbox_id_seq') !~ '(^|[{,])=' AS no_public`)).rows[0];
    expect(seq).toEqual({ a: false, b: false, api: true, no_public: true });
  });

  it('an unexpected error mid-run marks the run failed (not running) and writes a failed record', async () => {
    await failNext('recognition_run_photos', 1);
    const p1 = await photo(id.custOpen, 'cust'), p2 = await photo(id.custOpen, 'cust');
    const r = await run('cust', id.custOpen, [p1, p2]);
    expect(r.status).toBe(503); expect(r.body.error).toBe('recognition_unavailable');
    expect(state.engine).not.toHaveBeenCalled();
    const runRow = (await sql("SELECT id, status, failure_code, finished_at FROM recognition_runs WHERE requested_by_user_id=$1 ORDER BY requested_at DESC LIMIT 1", [id.custUser])).rows[0];
    expect(runRow).toMatchObject({ status: 'failed', failure_code: 'internal_error' }); expect(runRow.finished_at).toBeInstanceOf(Date);
    const recs = await records(runRow.id);
    expect(recs.map((x: any) => [x.photo_id, x.status, x.failure_code, x.provider_called]).sort()).toEqual([[p1, 'failed', 'internal_error', false], [p2, 'failed', 'internal_error', false]].sort());
    await failNext('recognition_run_photos', 0);
  });

});
describe('follow-ups (Oct 31 10:39): access denials, replays, scheduled outbox reprocessing', () => {
  const failNext = async (tbl: string, n: number) => { await sql("SELECT setval('t_fail_seq', 1, false)"); await sql('INSERT INTO t_fail VALUES($1,$2) ON CONFLICT (tbl) DO UPDATE SET max_fail=EXCLUDED.max_fail', [tbl, n]); };
  const denials = async () => { await flushAccessDenialWrites(); return (await sql('SELECT * FROM recognition_access_denials ORDER BY occurred_at, id')).rows; };
  const monthly = async (org: string) => (await asActor(id.oiUser, 'SELECT * FROM recognition_run_records_monthly WHERE organization_id=$1', [org]))[0];

  it('a replay is recorded as its own row without counting a run, a photo attempt or cost', async () => {
    const p = await photo(id.custOpen, 'cust'), crid = randomUUID();
    const send = () => request(app).post('/api/recognition/runs').set('Authorization', tok.cust).send({ opening_id: id.custOpen, photo_ids: [p], client_request_id: crid });
    const first = await send(); expect(first.status).toBe(201);
    const before = await monthly(id.cust);
    const again = await send(); expect(again.status).toBe(200); expect(again.body.replayed).toBe(true);
    expect(state.engine).toHaveBeenCalledTimes(1);
    const rows = await records(first.body.run.id);
    expect(rows.map((r: any) => r.status).sort()).toEqual(['replayed', 'succeeded']);
    expect(rows.find((r: any) => r.status === 'replayed')).toMatchObject({ failure_code: 'replay_of_existing_run', photo_id: null, provider_called: false,
      cost_per_photo_usd: null, opening_id: id.custOpen, property_id: id.custProp, requested_by_user_id: id.custUser });
    const after = await monthly(id.cust);
    expect([after.runs, after.photo_attempts, Number(after.oi_cost_usd), after.replayed_attempts])
      .toEqual([before.runs, before.photo_attempts, Number(before.oi_cost_usd), before.replayed_attempts + 1]);
    expect((await asActor(id.otherUser, "SELECT 1 FROM recognition_run_records WHERE status='replayed'"))).toEqual([]);
    const ins = (s: string, run: string | null, extra = '') => sql(`INSERT INTO recognition_run_records(attempt_id,run_id,organization_id,requested_by_user_id,property_id,opening_id,photo_id,status,failure_code,provider_called${extra ? ',cost_per_photo_usd' : ''})
      VALUES($1,$2,$3,$4,$5,$6,${s},'replayed','replay_of_existing_run',false${extra})`, [randomUUID(), run, id.cust, id.custUser, id.custProp, id.custOpen]);
    await expect(ins('NULL', null)).rejects.toThrow(/rejected_no_run/);
    await expect(ins(`'${p}'`, first.body.run.id)).rejects.toThrow(/replayed_shape/);
    await expect(ins('NULL', first.body.run.id, ',0.01')).rejects.toThrow(/replayed_shape/);
  });

  it('401/403 on the recognition endpoints are recorded outside the handlers; anonymous ones for staff only', async () => {
    const start = (await denials()).length;
    const viewer = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic viewer','viewer','not-a-real-password')", [viewer, id.cust, viewer + '@example.invalid']);
    const vtok = 'Bearer ' + jwt.sign({ userId: viewer, organizationId: id.cust, role: 'viewer', sessionVersion: 0 }, process.env.JWT_SECRET!);
    const r1 = await request(app).post('/api/recognition/runs').send({ opening_id: id.custOpen, photo_ids: [randomUUID()], client_request_id: randomUUID() });
    const r2 = await request(app).get('/api/recognition/runs/' + randomUUID()).set('Authorization', 'Bearer not-a-token');
    const r3 = await request(app).post('/api/recognition/runs').set('Authorization', vtok).send({});
    const r4 = await request(app).get('/api/recognition/anything').set('Authorization', vtok);
    expect([r1.status, r2.status, r3.status, r4.status]).toEqual([401, 401, 403, 403]);
    expect(r1.body.error).toBe('missing_token'); expect(r3.body).toEqual({ error: 'forbidden' }); // responses unchanged
    const rows = (await denials()).slice(start);
    expect(rows.map((d: any) => [d.http_status, d.reason, d.endpoint, d.method, d.user_id, d.organization_id])).toEqual([
      [401, 'missing_token', 'recognition_runs', 'POST', null, null],
      [401, 'invalid_token', 'recognition_runs', 'GET', null, null],
      [403, 'forbidden', 'recognition_runs', 'POST', viewer, id.cust],
      [403, 'forbidden', 'recognition', 'GET', viewer, id.cust]]);
    expect(rows[0].auth_reference).toBe(r1.headers['x-oi-auth-reference']);
    expect(state.engine).not.toHaveBeenCalled();
    // RLS: staff see everything; the company sees only its verified rows; others nothing; no actor nothing.
    expect((await asActor(id.oiUser, 'SELECT count(*)::int n FROM recognition_access_denials'))[0].n).toBe(start + 4);
    expect((await asActor(id.custUser, 'SELECT http_status, user_id FROM recognition_access_denials'))).toEqual([{ http_status: 403, user_id: viewer }, { http_status: 403, user_id: viewer }]);
    expect(await asActor(id.otherUser, 'SELECT 1 FROM recognition_access_denials')).toEqual([]);
    expect(await asActor(id.provUser, 'SELECT 1 FROM recognition_access_denials')).toEqual([]);
    expect(await asActor(null, 'SELECT 1 FROM recognition_access_denials')).toEqual([]);
    await expect(sql('DELETE FROM recognition_access_denials')).rejects.toThrow(/append_only/);
    await expect(sql("UPDATE recognition_access_denials SET reason='x'")).rejects.toThrow(/append_only/);
    await expect(sql("INSERT INTO recognition_access_denials(http_status,reason,endpoint,method,user_id) VALUES(401,'missing_token','recognition','GET',$1)", [viewer])).rejects.toThrow(/identity/);
    const priv = (await sql(`SELECT has_table_privilege('anon','recognition_access_denials','SELECT') a, has_table_privilege('authenticated','recognition_access_denials','INSERT') b,
      has_table_privilege('oi_pr2_api','recognition_access_denials','UPDATE') u`)).rows[0];
    expect(priv).toEqual({ a: false, b: false, u: false });
  });

  it('a denial write that fails is retried', async () => {
    await sql(`CREATE OR REPLACE FUNCTION t_deny_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('t_fail_seq') <= 2 THEN RAISE EXCEPTION 'synthetic_write_failure'; END IF; RETURN NEW; END $$`);
    await sql('CREATE TRIGGER t_deny_fail BEFORE INSERT ON recognition_access_denials FOR EACH ROW EXECUTE FUNCTION t_deny_fail()');
    await sql("SELECT setval('t_fail_seq', 1, false)");
    const start = (await denials()).length;
    expect((await request(app).get('/api/recognition/runs')).status).toBe(401);
    expect((await denials()).length).toBe(start + 1);
    await sql('DROP TRIGGER t_deny_fail ON recognition_access_denials');
  });

  it('scheduled reprocessor: the SQL function drains the outbox (as the cron owner or the API role), SKIP LOCKED, idempotent', async () => {
    await failNext('recognition_run_records', 1000);
    const a = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust')]);
    const b = await run('cust', id.custOpen, [await photo(id.custOpen, 'cust')]);
    await failNext('recognition_run_records', 0);
    expect((await sql('SELECT count(*)::int n FROM recognition_run_record_outbox WHERE processed_at IS NULL')).rows[0].n).toBe(2);
    // As the database owner (how pg_cron runs it), one entry per run.
    expect((await sql('SELECT * FROM recognition_run_record_outbox_reprocess(1)')).rows[0]).toEqual({ processed: 1, failed: 0, pending: 1 });
    await sql('GRANT SELECT ON t_fail TO oi_pr2_api; '.trim()); await sql('GRANT USAGE ON SEQUENCE t_fail_seq TO oi_pr2_api'); // test-only injection trigger
    const viaApi = await asActor(null, 'SELECT * FROM recognition_run_record_outbox_reprocess(10)');
    expect(viaApi).toEqual([{ processed: 1, failed: 0, pending: 0 }]);
    // The API role (no acting user, so RLS shows it nothing) can still write idempotently via the write function.
    const row = { ...(await records(a.body.run.id))[0] }; const attempt = randomUUID();
    const payload = JSON.stringify([{ ...row, attempt_id: attempt, run_id: null, photo_id: null, status: 'rejected', failure_code: 'opening_not_found', provider_called: false,
      manufacturer: null, manufacturer_confidence: null, series: null, series_confidence: null, model: null, model_confidence: null, model_marking_evidence: false }]);
    expect(await asActor(null, 'SELECT recognition_run_records_write($1::jsonb) n', [payload])).toEqual([{ n: 1 }]);
    expect(await asActor(null, 'SELECT recognition_run_records_write($1::jsonb) n', [payload])).toEqual([{ n: 0 }]);
    await expect(asActor(null, "INSERT INTO recognition_run_records(attempt_id,organization_id,requested_by_user_id,status,failure_code,provider_called) VALUES($1,$2,$3,'rejected','x',false) ON CONFLICT (attempt_id, photo_slot) DO NOTHING", [attempt, id.cust, id.custUser])).rejects.toThrow(/row-level security/);
    expect((await sql('SELECT * FROM recognition_run_record_outbox_reprocess(10)')).rows[0]).toEqual({ processed: 0, failed: 0, pending: 0 });
    for (const r of [a, b]) expect(await records(r.body.run.id)).toMatchObject([{ status: 'succeeded' }]);
    const def = (await sql("SELECT pg_get_functiondef('recognition_run_record_outbox_reprocess(integer)'::regprocedure) d")).rows[0].d;
    expect(def).toMatch(/FOR UPDATE OF o SKIP LOCKED/);
    expect((await sql("SELECT has_function_privilege('anon','recognition_run_record_outbox_reprocess(integer)','EXECUTE') a")).rows[0].a).toBe(false);
    // Staff endpoint is kept and uses the same function.
    expect((await request(app).post('/api/platform/recognition-run-records/outbox/reprocess').set('Authorization', tok.oi).send({})).body).toEqual({ processed: 0, failed: 0, pending: 0 });
  });

  it('the pg_cron job ships disabled: outside migrations/, documented, idempotent schedule and unschedule', () => {
    expect(readdirSync('migrations').some(f => /cron/i.test(f))).toBe(false);
    const cron = readFileSync('docs/scheduled/recognition_record_outbox_reprocess_cron.sql', 'utf8');
    expect(cron).toMatch(/NOT APPLIED/); expect(cron).toMatch(/separate deploy approval/);
    expect(cron).toMatch(/cron\.schedule\('oi-recognition-record-outbox-reprocess', '\*\/5 \* \* \* \*',\s*\$job\$SELECT \* FROM public\.recognition_run_record_outbox_reprocess\(200\)\$job\$\)/);
    expect(cron).toMatch(/cron\.unschedule\('oi-recognition-record-outbox-reprocess'\)/);
    expect(readFileSync('docs/rollback/20261031090000_recognition_run_records_rollback.sql', 'utf8')).toMatch(/cron\.unschedule/);
  });
});