import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth';
import { openingsForOrgSubquery, photoVisibleSql } from '../db/tenantScope';
import { legacyVisionHandler } from '../services/legacyVision';
import { getObjectBytes } from '../services/storage';
import { downscaleForRecognition, DownscaleError, MAX_ORIGINAL_READ_BYTES } from '../services/recognitionDownscale';
import { buildReferenceContext, validateCitations, REFERENCE_CONTEXT_VERSION, type ReferenceContext } from '../services/referenceRetrieval';
import { randomUUID } from 'node:crypto';
import { recordRunAttempt, recordRejectedAttempt, recordReplayedAttempt } from '../services/recognitionRunRecords';
import { LEGACY_VISION_ENGINE_CONFIG, buildCommit, conservativeIdentity, sha256Hex, MAX_PROVIDER_IMAGE_BYTES, RECOGNITION_PREPROCESSING_VERSION } from '../services/recognitionRuns';

// Hosting plan step 1 (t130): every recognition attempt is a recognition_runs row linked to the
// STORED original photo(s) by id + sha256. Off unless OI_RECOGNITION_ENABLED=true.
// One provider call per run, never retried: a lost or unreadable response is recorded as
// 'ambiguous' (it may have been billed) and a new run needs a new client_request_id.
// Step 2 (revised Oct 29, 11:17): no customer budgets. Usage is counted per company per month
// (photos + runs) by recognition_usage_reserve immediately before the provider call; one conditional
// UPDATE under the monthly row lock. It only refuses at the emergency safety cap: the run is then
// recorded as 'refused' / 'safety_cap_exceeded' and the provider is not called.
// Originals over 5 MB get a tracked downscale copy for recognition only; the original is untouched.
const createSchema = z.object({
  opening_id: z.string().uuid(),
  photo_ids: z.array(z.string().uuid()).min(1).max(5),
  client_request_id: z.string().uuid(),
  repeat_of_run_id: z.string().uuid().optional(),
}).strict();
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);
const RUN_COLUMNS = `r.id,r.organization_id,r.property_id,r.opening_id,r.requested_by_user_id,r.client_request_id,r.repeat_of_run_id,
  r.mode,r.input_source,r.build_commit,r.processing_config,r.status,r.failure_code,r.result,r.result_level,r.manufacturer,r.series,r.model,
  r.requires_technician_review,r.requested_at,r.started_at,r.finished_at,r.photo_count,r.usage_photo_count,r.downscale_used,
  COALESCE((SELECT json_agg(json_build_object('photo_id',rp.photo_id,'sha256_checksum',rp.sha256_checksum,'original_byte_size',rp.original_byte_size,
    'downscaled',rp.downscaled,'derived_sha256_checksum',rp.derived_sha256_checksum,'derived_byte_size',rp.derived_byte_size,
    'downscale_method_version',rp.downscale_method_version,'downscale_target',rp.downscale_target,'derived_width',rp.derived_width,'derived_height',rp.derived_height) ORDER BY rp.ordinal)
    FROM recognition_run_photos rp WHERE rp.run_id=r.id),'[]'::json) AS photos`;
// A run is readable by the company that requested it, or by the facility owner, and only while the
// caller can still reach the opening (owner or active provider assignment). Other providers: 404.
const runVisible = (org: number) => `r.opening_id IN (${openingsForOrgSubquery(org)}) AND (r.organization_id=$${org} OR EXISTS (
  SELECT 1 FROM properties rv_p JOIN portfolios rv_pf ON rv_pf.id=rv_p.portfolio_id WHERE rv_p.id=r.property_id AND rv_pf.organization_id=$${org}))`;

async function readRun(id: string, org: string) {
  const run = (await pool.query(`SELECT ${RUN_COLUMNS} FROM recognition_runs r WHERE r.id=$1 AND ${runVisible(2)}`, [id, org])).rows[0] ?? null;
  if (!run) return null;
  // Reference columns exist once 20261030091000 is applied; before that a run simply has none.
  try { const x = (await pool.query('SELECT reference_release_id, reference_citations FROM recognition_runs WHERE id=$1', [id])).rows[0];
    if (x) { run.reference_release_id = x.reference_release_id; run.reference_citations = x.reference_citations; } } catch { /* library not migrated */ }
  return run;
}
async function finish(id: string, fields: { status: string; failure_code?: string | null; result?: unknown; level?: string | null; manufacturer?: string | null; series?: string | null; model?: string | null; downscale_used?: boolean }) {
  await pool.query(`UPDATE recognition_runs SET status=$2,failure_code=$3,result=$4,result_level=$5,manufacturer=$6,series=$7,model=$8,downscale_used=$9,finished_at=now() WHERE id=$1 AND status='running'`,
    [id, fields.status, fields.failure_code ?? null, fields.result === undefined ? null : JSON.stringify(fields.result), fields.level ?? null, fields.manufacturer ?? null, fields.series ?? null, fields.model ?? null, fields.downscale_used ?? false]);
}

export const recognitionRunsRouter = Router();
recognitionRunsRouter.use(requireAuth, requireRole('admin', 'technician', 'inspector', 'facilities_manager'));
recognitionRunsRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

recognitionRunsRouter.post('/', async (req: AuthedRequest, res) => {
  const org = req.auth!.organizationId, user = req.auth!.userId;
  // Every attempt is recorded. Refusals before a run exists become a 'rejected' record with the
  // reason (facility/opening only once the requester is known to reach the opening).
  let ctx: { opening_id: string; property_id: string } | null = null;
  const reject = async (code: number, error: string) => {
    await recordRejectedAttempt({ attemptId: randomUUID(), organizationId: org, requestedByUserId: user, propertyId: ctx?.property_id ?? null, openingId: ctx?.opening_id ?? null, reason: error });
    return res.status(code).json({ error });
  };
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success || new Set(parsed.data.photo_ids).size !== parsed.data.photo_ids.length) return reject(400, 'invalid_recognition_run_request');
  const b = parsed.data;
  let runId: string | null = null, finished = false, providerCalled = false;
  try {
    const opening = (await pool.query(`SELECT o.id, b.property_id FROM openings o JOIN buildings b ON b.id=o.building_id
      WHERE o.id=$1 AND o.id IN (${openingsForOrgSubquery(2)})`, [b.opening_id, org])).rows[0];
    if (!opening) return reject(404, 'opening_not_found');
    ctx = { opening_id: opening.id, property_id: opening.property_id };
    // Replay of the same request returns the existing run; it never calls the provider again.
    const prior = (await pool.query('SELECT id FROM recognition_runs WHERE requested_by_user_id=$1 AND client_request_id=$2', [user, b.client_request_id])).rows[0];
    if (prior) {
      const run = await readRun(prior.id, org);
      if (!run) return reject(409, 'client_request_id_in_use');
      // Recorded as its own 'replayed' row (no photo attempt, no cost) pointing at the existing run.
      await recordReplayedAttempt({ attemptId: randomUUID(), runId: prior.id, organizationId: org, requestedByUserId: user, propertyId: ctx.property_id, openingId: ctx.opening_id });
      return res.status(200).json({ run, replayed: true });
    }
    const photos = (await pool.query(`SELECT p.id,p.sha256_checksum,p.storage_object_key,p.content_type FROM photos p
      WHERE p.id=ANY($1::uuid[]) AND p.opening_id=$3 AND p.media_type='photo' AND p.upload_state IN ('verified','legacy_confirmed')
      AND p.sha256_checksum IS NOT NULL AND p.storage_object_key IS NOT NULL AND ${photoVisibleSql('p', 2)}`, [b.photo_ids, org, b.opening_id])).rows;
    if (photos.length !== b.photo_ids.length) return reject(404, 'stored_original_not_found');
    const types = new Set(photos.map((p: any) => p.content_type));
    if (types.size !== 1 || !MEDIA.has(photos[0].content_type)) return reject(400, 'unsupported_or_mixed_media_type');
    if (b.repeat_of_run_id && !(await readRun(b.repeat_of_run_id, org))) return reject(404, 'repeat_of_run_not_found');
    // Explicit release switch: no run row and no provider call while disabled.
    if (process.env.OI_RECOGNITION_ENABLED !== 'true' || !process.env.ANTHROPIC_API_KEY) return reject(503, 'recognition_unavailable');

    // Reference library: approved facts from the single active release only. Hints come from the opening's
    // recorded hardware. No release (or no library yet) -> null: the run proceeds and cites nothing.
    let ref: ReferenceContext | null = null;
    try {
      const hints = (await pool.query('SELECT manufacturer, model_number FROM hardware_components WHERE opening_id=$1 LIMIT 50', [b.opening_id])).rows
        .flatMap((h: any) => [h.manufacturer, h.model_number]).filter(Boolean);
      ref = await buildReferenceContext(pool, hints);
    } catch { ref = null; }
    const config = { ...LEGACY_VISION_ENGINE_CONFIG, mode: 'identify', preprocessing_version: RECOGNITION_PREPROCESSING_VERSION,
      ...(ref ? { reference_context_version: REFERENCE_CONTEXT_VERSION, reference_release_version: ref.version, reference_fact_count: ref.facts.length } : {}) };
    const inserted = (await pool.query(`INSERT INTO recognition_runs(organization_id,property_id,opening_id,requested_by_user_id,client_request_id,repeat_of_run_id,mode,build_commit,processing_config,status,started_at,photo_count)
      VALUES($1,$2,$3,$4,$5,$6,'identify',$7,$8,'running',now(),$9) ON CONFLICT (requested_by_user_id,client_request_id) DO NOTHING RETURNING id`,
      [org, opening.property_id, b.opening_id, user, b.client_request_id, b.repeat_of_run_id ?? null, buildCommit(), JSON.stringify(config), b.photo_ids.length])).rows[0];
    if (!inserted) return reject(409, 'client_request_id_in_use');
    runId = inserted.id;
    // Every run that used a release records it, whatever the outcome.
    if (ref) await pool.query('UPDATE recognition_runs SET reference_release_id=$2 WHERE id=$1', [inserted.id, ref.release_id]);
    const ordered = b.photo_ids.map(id => photos.find((p: any) => p.id === id));
    // Every run writes one recognition_run_records row per photo (success, failure, or refusal by
    // the safety cap), with retries and the outbox fallback; recording never changes the outcome.
    const done = async (f: Parameters<typeof finish>[1], code = 200) => {
      await finish(inserted.id, f); finished = true;
      await recordRunAttempt({ runId: inserted.id, organizationId: org, requestedByUserId: user, propertyId: opening.property_id, openingId: b.opening_id, photoIds: b.photo_ids,
        runStatus: f.status, failureCode: f.failure_code ?? null, result: f.result ?? null, providerCalled,
        identity: f.level ? { level: f.level as any, manufacturer: f.manufacturer ?? null, series: f.series ?? null, model: f.model ?? null } : null });
      return res.status(code).json({ run: await readRun(inserted.id, org) });
    };

    // Read each stored original, prove it is the bytes the run claims, then (only if > 5 MB) make a
    // tracked smaller copy for the provider. Every photo is linked to the run with what was sent.
    const images: string[] = []; let downscaleUsed = false;
    for (const [i, p] of ordered.entries()) {
      const link = (d?: Awaited<ReturnType<typeof downscaleForRecognition>>, size?: number) => pool.query(`INSERT INTO recognition_run_photos(run_id,photo_id,sha256_checksum,ordinal,original_byte_size,
          downscaled,derived_sha256_checksum,derived_byte_size,downscale_method_version,downscale_target,derived_width,derived_height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [inserted.id, p.id, p.sha256_checksum, i, size ?? null, !!d, d?.sha256 ?? null, d?.bytes.byteLength ?? null, d?.method_version ?? null, d ? JSON.stringify(d.target) : null, d?.width ?? null, d?.height ?? null]);
      let bytes: Uint8Array;
      try { bytes = await getObjectBytes(p.storage_object_key, MAX_ORIGINAL_READ_BYTES); }
      catch (e: any) { await link(); return done({ status: 'failed', failure_code: e?.message === 'object_too_large' ? 'original_too_large' : 'stored_original_unreadable' }); }
      if (sha256Hex(bytes) !== p.sha256_checksum) { await link(); return done({ status: 'failed', failure_code: 'stored_original_checksum_mismatch' }); }
      if (bytes.byteLength <= MAX_PROVIDER_IMAGE_BYTES) { await link(undefined, bytes.byteLength); images.push(Buffer.from(bytes).toString('base64')); continue; }
      let d: Awaited<ReturnType<typeof downscaleForRecognition>>;
      try { d = await downscaleForRecognition(bytes, p.content_type); }
      catch (e) { await link(undefined, bytes.byteLength); return done({ status: 'failed', failure_code: e instanceof DownscaleError ? e.message : 'downscale_failed' }); }
      await link(d, bytes.byteLength); downscaleUsed = true; images.push(Buffer.from(d.bytes).toString('base64'));
    }

    // Atomic usage count against the emergency safety cap, immediately before the (paid) provider call.
    let usage: string | undefined;
    try { usage = (await pool.query('SELECT recognition_usage_reserve($1) AS outcome', [inserted.id])).rows[0]?.outcome; } catch { usage = undefined; }
    if (usage === 'safety_cap_exceeded') return done({ status: 'refused', failure_code: 'safety_cap_exceeded', downscale_used: downscaleUsed });
    // Never call the provider uncounted.
    if (usage !== 'reserved') return done({ status: 'failed', failure_code: 'usage_tracking_unavailable', downscale_used: downscaleUsed });
    let response: { statusCode: number; body: string };
    providerCalled = true;
    try { response = await legacyVisionHandler({ httpMethod: 'POST', body: JSON.stringify({ images, media_type: photos[0].content_type, mode: 'identify', ...(ref?.prompt ? { reference_context: ref.prompt } : {}) }) }); }
    catch { return done({ status: 'ambiguous', failure_code: 'provider_call_outcome_unknown', downscale_used: downscaleUsed }); }
    if (response.statusCode !== 200) {
      // 5xx from the engine wrapper includes thrown fetch errors (e.g. timeout): the call may have been billed.
      return done(response.statusCode >= 500 && response.statusCode !== 502
        ? { status: 'ambiguous', failure_code: 'provider_call_outcome_unknown', downscale_used: downscaleUsed } : { status: 'failed', failure_code: 'provider_failed', downscale_used: downscaleUsed });
    }
    let result: any;
    try { result = JSON.parse(response.body); } catch { result = null; }
    if (!result || typeof result !== 'object' || Array.isArray(result)) return done({ status: 'failed', failure_code: 'provider_result_unreadable', downscale_used: downscaleUsed });
    const id = conservativeIdentity(result);
    if (ref) await pool.query('UPDATE recognition_runs SET reference_citations=$2 WHERE id=$1', [inserted.id, JSON.stringify(validateCitations(result, ref))]);
    return done({ status: id.level === 'none' ? 'abstained' : 'succeeded', result, level: id.level, manufacturer: id.manufacturer, series: id.series, model: id.model, downscale_used: downscaleUsed }, 201);
  } catch {
    // Unexpected error. Mid-run: the run is marked failed ('internal_error') instead of staying
    // 'running', and a failed record is written. Before a run: a 'rejected' record. After the run
    // finished (e.g. the read-back failed): its records already exist.
    if (runId && !finished) {
      try { await finish(runId, { status: 'failed', failure_code: 'internal_error' }); } catch { console.error('recognition_run_finish_failed', runId); }
      await recordRunAttempt({ runId, organizationId: org, requestedByUserId: user, propertyId: ctx!.property_id, openingId: ctx!.opening_id, photoIds: b.photo_ids,
        runStatus: 'failed', failureCode: 'internal_error', result: null, identity: null, providerCalled });
    } else if (!runId) {
      await recordRejectedAttempt({ attemptId: randomUUID(), organizationId: org, requestedByUserId: user, propertyId: ctx?.property_id ?? null, openingId: ctx?.opening_id ?? null, reason: 'internal_error' });
    }
    return res.status(503).json({ error: 'recognition_unavailable' });
  }
});

recognitionRunsRouter.get('/:id', async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: 'not_found' });
  try { const run = await readRun(req.params.id, req.auth!.organizationId); return run ? res.json({ run }) : res.status(404).json({ error: 'not_found' }); }
  catch { return res.status(503).json({ error: 'recognition_unavailable' }); }
});

recognitionRunsRouter.get('/', async (req: AuthedRequest, res) => {
  const opening = z.string().uuid().safeParse(req.query.opening_id);
  if (!opening.success) return res.status(400).json({ error: 'opening_id_required' });
  try {
    const runs = (await pool.query(`SELECT ${RUN_COLUMNS} FROM recognition_runs r WHERE r.opening_id=$1 AND ${runVisible(2)} ORDER BY r.requested_at DESC, r.id LIMIT 100`, [opening.data, req.auth!.organizationId])).rows;
    return res.json({ runs });
  } catch { return res.status(503).json({ error: 'recognition_unavailable' }); }
});
