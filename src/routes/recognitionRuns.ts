import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth';
import { openingsForOrgSubquery, photoVisibleSql } from '../db/tenantScope';
import { legacyVisionHandler } from '../services/legacyVision';
import { getObjectBytes } from '../services/storage';
import { downscaleForRecognition, DownscaleError, MAX_ORIGINAL_READ_BYTES } from '../services/recognitionDownscale';
import { LEGACY_VISION_ENGINE_CONFIG, buildCommit, conservativeIdentity, sha256Hex, MAX_PROVIDER_IMAGE_BYTES, RECOGNITION_PREPROCESSING_VERSION } from '../services/recognitionRuns';

// Hosting plan step 1 (t130): every recognition attempt is a recognition_runs row linked to the
// STORED original photo(s) by id + sha256. Off unless OI_RECOGNITION_ENABLED=true.
// One provider call per run, never retried: a lost or unreadable response is recorded as
// 'ambiguous' (it may have been billed) and a new run needs a new client_request_id.
// Step 2: an atomic per-company budget reservation (recognition_budget_reserve, one conditional
// UPDATE under the budget row lock) happens immediately before the provider call. A refusal is
// recorded on the run as status 'refused' with the reason; the provider is not called.
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
  r.requires_technician_review,r.requested_at,r.started_at,r.finished_at,r.budget_cents,r.downscale_used,
  COALESCE((SELECT json_agg(json_build_object('photo_id',rp.photo_id,'sha256_checksum',rp.sha256_checksum,'original_byte_size',rp.original_byte_size,
    'downscaled',rp.downscaled,'derived_sha256_checksum',rp.derived_sha256_checksum,'derived_byte_size',rp.derived_byte_size,
    'downscale_method_version',rp.downscale_method_version,'downscale_target',rp.downscale_target,'derived_width',rp.derived_width,'derived_height',rp.derived_height) ORDER BY rp.ordinal)
    FROM recognition_run_photos rp WHERE rp.run_id=r.id),'[]'::json) AS photos`;
// A run is readable by the company that requested it, or by the facility owner, and only while the
// caller can still reach the opening (owner or active provider assignment). Other providers: 404.
const runVisible = (org: number) => `r.opening_id IN (${openingsForOrgSubquery(org)}) AND (r.organization_id=$${org} OR EXISTS (
  SELECT 1 FROM properties rv_p JOIN portfolios rv_pf ON rv_pf.id=rv_p.portfolio_id WHERE rv_p.id=r.property_id AND rv_pf.organization_id=$${org}))`;

async function readRun(id: string, org: string) {
  return (await pool.query(`SELECT ${RUN_COLUMNS} FROM recognition_runs r WHERE r.id=$1 AND ${runVisible(2)}`, [id, org])).rows[0] ?? null;
}
async function finish(id: string, fields: { status: string; failure_code?: string | null; result?: unknown; level?: string | null; manufacturer?: string | null; series?: string | null; model?: string | null; downscale_used?: boolean }) {
  await pool.query(`UPDATE recognition_runs SET status=$2,failure_code=$3,result=$4,result_level=$5,manufacturer=$6,series=$7,model=$8,downscale_used=$9,finished_at=now() WHERE id=$1 AND status='running'`,
    [id, fields.status, fields.failure_code ?? null, fields.result === undefined ? null : JSON.stringify(fields.result), fields.level ?? null, fields.manufacturer ?? null, fields.series ?? null, fields.model ?? null, fields.downscale_used ?? false]);
}

export const recognitionRunsRouter = Router();
recognitionRunsRouter.use(requireAuth, requireRole('admin', 'technician', 'inspector', 'facilities_manager'));
recognitionRunsRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

recognitionRunsRouter.post('/', async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success || new Set(parsed.data.photo_ids).size !== parsed.data.photo_ids.length) return res.status(400).json({ error: 'invalid_recognition_run_request' });
  const b = parsed.data, org = req.auth!.organizationId, user = req.auth!.userId;
  try {
    const opening = (await pool.query(`SELECT o.id, b.property_id FROM openings o JOIN buildings b ON b.id=o.building_id
      WHERE o.id=$1 AND o.id IN (${openingsForOrgSubquery(2)})`, [b.opening_id, org])).rows[0];
    if (!opening) return res.status(404).json({ error: 'opening_not_found' });
    // Replay of the same request returns the existing run; it never calls the provider again.
    const prior = (await pool.query('SELECT id FROM recognition_runs WHERE requested_by_user_id=$1 AND client_request_id=$2', [user, b.client_request_id])).rows[0];
    if (prior) {
      const run = await readRun(prior.id, org);
      return run ? res.status(200).json({ run, replayed: true }) : res.status(409).json({ error: 'client_request_id_in_use' });
    }
    const photos = (await pool.query(`SELECT p.id,p.sha256_checksum,p.storage_object_key,p.content_type FROM photos p
      WHERE p.id=ANY($1::uuid[]) AND p.opening_id=$3 AND p.media_type='photo' AND p.upload_state IN ('verified','legacy_confirmed')
      AND p.sha256_checksum IS NOT NULL AND p.storage_object_key IS NOT NULL AND ${photoVisibleSql('p', 2)}`, [b.photo_ids, org, b.opening_id])).rows;
    if (photos.length !== b.photo_ids.length) return res.status(404).json({ error: 'stored_original_not_found' });
    const types = new Set(photos.map((p: any) => p.content_type));
    if (types.size !== 1 || !MEDIA.has(photos[0].content_type)) return res.status(400).json({ error: 'unsupported_or_mixed_media_type' });
    if (b.repeat_of_run_id && !(await readRun(b.repeat_of_run_id, org))) return res.status(404).json({ error: 'repeat_of_run_not_found' });
    // Explicit release switch: no run row and no provider call while disabled.
    if (process.env.OI_RECOGNITION_ENABLED !== 'true' || !process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'recognition_unavailable' });

    const config = { ...LEGACY_VISION_ENGINE_CONFIG, mode: 'identify', preprocessing_version: RECOGNITION_PREPROCESSING_VERSION };
    const inserted = (await pool.query(`INSERT INTO recognition_runs(organization_id,property_id,opening_id,requested_by_user_id,client_request_id,repeat_of_run_id,mode,build_commit,processing_config,status,started_at)
      VALUES($1,$2,$3,$4,$5,$6,'identify',$7,$8,'running',now()) ON CONFLICT (requested_by_user_id,client_request_id) DO NOTHING RETURNING id`,
      [org, opening.property_id, b.opening_id, user, b.client_request_id, b.repeat_of_run_id ?? null, buildCommit(), JSON.stringify(config)])).rows[0];
    if (!inserted) return res.status(409).json({ error: 'client_request_id_in_use' });
    const ordered = b.photo_ids.map(id => photos.find((p: any) => p.id === id));
    const done = async (f: Parameters<typeof finish>[1], code = 200) => { await finish(inserted.id, f); return res.status(code).json({ run: await readRun(inserted.id, org) }); };

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

    // Atomic budget check-and-spend, immediately before the (paid) provider call.
    const budget = (await pool.query('SELECT recognition_budget_reserve($1) AS outcome', [inserted.id])).rows[0]?.outcome;
    if (budget !== 'reserved') return done({ status: 'refused', failure_code: budget === 'budget_exceeded' ? 'budget_exceeded' : 'budget_not_configured', downscale_used: downscaleUsed });
    let response: { statusCode: number; body: string };
    try { response = await legacyVisionHandler({ httpMethod: 'POST', body: JSON.stringify({ images, media_type: photos[0].content_type, mode: 'identify' }) }); }
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
    return done({ status: id.level === 'none' ? 'abstained' : 'succeeded', result, level: id.level, manufacturer: id.manufacturer, series: id.series, model: id.model, downscale_used: downscaleUsed }, 201);
  } catch { return res.status(503).json({ error: 'recognition_unavailable' }); }
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
