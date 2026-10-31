import { pool } from '../db/pool';
import type { Identity } from './recognitionRuns';
// Recognition run records (Oct 31 2026 milestone; DRAFT migration 20261031090000, not applied).
// One row per photo per attempt, written for EVERY attempt: success, failure (incl. unexpected
// errors mid-run), refusal by the emergency safety cap, and refusal before a run existed
// ('rejected' + reason). Writes are idempotent (attempt_id, photo_slot), retried with backoff, and
// if they still fail the rows go to recognition_run_record_outbox for staff reprocessing.
// The record functions here never throw: recording must never change what the caller sees.

export type RecordStatus = 'succeeded' | 'failed' | 'blocked_by_cap' | 'rejected' | 'replayed';
// Run status -> record status. 'abstained' is a successful attempt that matched nothing;
// 'ambiguous' (provider outcome unknown) counts as failed but keeps provider_called = true.
export function recordStatus(runStatus: string): RecordStatus {
  if (runStatus === 'succeeded' || runStatus === 'abstained') return 'succeeded';
  if (runStatus === 'refused') return 'blocked_by_cap';
  return 'failed';
}

const conf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4 : null);
export type MatchedLevels = {
  manufacturer: string | null; manufacturer_confidence: number | null;
  series: string | null; series_confidence: number | null;
  model: string | null; model_confidence: number | null; model_marking_evidence: boolean;
};
// Only the levels the conservative identity accepted are recorded, each with its confidence score.
export function matchedLevels(result: any, id: Identity | null): MatchedLevels {
  const c = result && typeof result === 'object' && result.confidence && typeof result.confidence === 'object' ? result.confidence : {};
  const at = (l: 'manufacturer' | 'series' | 'model') => !!id && id[l] !== null;
  return {
    manufacturer: at('manufacturer') ? id!.manufacturer : null, manufacturer_confidence: at('manufacturer') ? conf(c.manufacturer) : null,
    series: at('series') ? id!.series : null, series_confidence: at('series') ? conf(c.series) : null,
    model: at('model') ? id!.model : null, model_confidence: at('model') ? conf(c.model) : null,
    model_marking_evidence: at('model'),
  };
}

export type RecordRow = MatchedLevels & {
  attempt_id: string; photo_slot: number; run_id: string | null; organization_id: string; requested_by_user_id: string;
  property_id: string | null; opening_id: string | null; photo_id: string | null;
  status: RecordStatus; failure_code: string | null; provider_called: boolean; recorded_at: string;
};

export function runRecordRows(a: {
  runId: string; organizationId: string; requestedByUserId: string; propertyId: string; openingId: string; photoIds: string[];
  runStatus: string; failureCode: string | null; result: unknown; identity: Identity | null; providerCalled: boolean;
}): RecordRow[] {
  const status = recordStatus(a.runStatus);
  const m = status === 'succeeded' ? matchedLevels(a.result, a.identity) : matchedLevels(null, null);
  const at = new Date().toISOString();
  return a.photoIds.map((photo, slot) => ({
    attempt_id: a.runId, photo_slot: slot, run_id: a.runId, organization_id: a.organizationId, requested_by_user_id: a.requestedByUserId,
    property_id: a.propertyId, opening_id: a.openingId, photo_id: photo, status,
    failure_code: status === 'succeeded' ? null : (a.failureCode ?? 'unknown_failure'),
    provider_called: status === 'blocked_by_cap' ? false : a.providerCalled, recorded_at: at, ...m,
  }));
}

const REASON = /^[a-z0-9_]{1,64}$/;
export function rejectedRecordRow(a: { attemptId: string; organizationId: string; requestedByUserId: string; propertyId: string | null; openingId: string | null; reason: string }): RecordRow {
  return {
    attempt_id: a.attemptId, photo_slot: 0, run_id: null, organization_id: a.organizationId, requested_by_user_id: a.requestedByUserId,
    property_id: a.openingId && a.propertyId ? a.propertyId : null, opening_id: a.openingId && a.propertyId ? a.openingId : null, photo_id: null,
    status: 'rejected', failure_code: REASON.test(a.reason) ? a.reason : 'unknown_reason', provider_called: false,
    recorded_at: new Date().toISOString(), ...matchedLevels(null, null),
  };
}

// A replay that returned an existing run: one row pointing at that run, no photo, no cost.
export function replayedRecordRow(a: { attemptId: string; runId: string; organizationId: string; requestedByUserId: string; propertyId: string; openingId: string }): RecordRow {
  return {
    attempt_id: a.attemptId, photo_slot: 0, run_id: a.runId, organization_id: a.organizationId, requested_by_user_id: a.requestedByUserId,
    property_id: a.propertyId, opening_id: a.openingId, photo_id: null, status: 'replayed', failure_code: 'replay_of_existing_run',
    provider_called: false, recorded_at: new Date().toISOString(), ...matchedLevels(null, null),
  };
}

// Insert; idempotent. cost: undefined = snapshot the current setting, otherwise use the given snapshot.
async function insertRows(rows: RecordRow[], cost?: number | string | null): Promise<void> {
  await pool.query('SELECT recognition_run_records_write($1::jsonb, $2, $3)', [JSON.stringify(rows), cost !== undefined, cost ?? null]);
}

// Backoff between write attempts (ms): 4 attempts in total. Tests shorten it.
export const RECORD_WRITE_RETRY = { delaysMs: [100, 400, 1600] };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const errText = (e: any) => String((e && (e.code ? e.code + ': ' : '') + (e.message ?? e)) || 'error').replace(/\s+/g, ' ').slice(0, 300) || 'error';

export type PersistOutcome = 'written' | 'outboxed' | 'lost';
export async function persistRecords(rows: RecordRow[]): Promise<PersistOutcome> {
  if (!rows.length) return 'written';
  let last: unknown;
  for (let i = 0; i <= RECORD_WRITE_RETRY.delaysMs.length; i++) {
    if (i > 0) await sleep(RECORD_WRITE_RETRY.delaysMs[i - 1]);
    try { await insertRows(rows); return 'written'; } catch (e) { last = e; }
  }
  // Durable fallback, with the cost snapshot taken now (when the attempt happened).
  for (let i = 0; i < 2; i++) {
    try {
      await pool.query(`INSERT INTO recognition_run_record_outbox(attempt_id, record_rows, cost_per_photo_usd, first_error)
        VALUES($1, $2::jsonb, (SELECT cost_per_photo_usd FROM recognition_usage_settings WHERE id), $3)`, [rows[0].attempt_id, JSON.stringify(rows), errText(last)]);
      console.error('recognition_run_record_outboxed', rows[0].attempt_id);
      return 'outboxed';
    } catch (e) { last = e; if (i === 0) await sleep(RECORD_WRITE_RETRY.delaysMs[0] ?? 0); }
  }
  // Database unreachable for both: the only trace left is this log line (ids only, no data).
  console.error('recognition_run_record_lost', rows[0].attempt_id);
  return 'lost';
}

export const recordRunAttempt = (a: Parameters<typeof runRecordRows>[0]) => persistRecords(runRecordRows(a)).catch(() => 'lost' as const);
export const recordReplayedAttempt = (a: Parameters<typeof replayedRecordRow>[0]) => persistRecords([replayedRecordRow(a)]).catch(() => 'lost' as const);
export const recordRejectedAttempt = (a: Parameters<typeof rejectedRecordRow>[0]) => persistRecords([rejectedRecordRow(a)]).catch(() => 'lost' as const);

// Outbox reprocessing (staff endpoint; the optional pg_cron job calls the same SQL function):
// oldest first, FOR UPDATE SKIP LOCKED (safe concurrently), idempotent, entries kept and marked
// processed; a failure bumps attempts and keeps the entry pending.
export async function reprocessRecordOutbox(limit = 100): Promise<{ processed: number; failed: number; pending: number }> {
  const r = (await pool.query('SELECT processed, failed, pending FROM recognition_run_record_outbox_reprocess($1)', [Math.max(1, Math.min(500, Math.floor(limit)))])).rows[0];
  return { processed: r.processed, failed: r.failed, pending: r.pending };
}
export async function recordOutboxStatus(): Promise<{ pending: number; oldest_pending_at: string | null; processed: number }> {
  const r = (await pool.query(`SELECT count(*) FILTER (WHERE processed_at IS NULL)::int pending, count(*) FILTER (WHERE processed_at IS NOT NULL)::int processed,
    min(created_at) FILTER (WHERE processed_at IS NULL) oldest FROM recognition_run_record_outbox`)).rows[0];
  return { pending: r.pending, processed: r.processed, oldest_pending_at: r.oldest ? new Date(r.oldest).toISOString() : null };
}

export type RunRecordsMonthlyRow = {
  period_month: string; organization_id: string; organization_name: string; org_type: string;
  runs: number; photo_attempts: number; succeeded_photos: number; failed_photos: number; blocked_by_cap_photos: number; rejected_attempts: number; replayed_attempts: number;
  provider_photos: number; manufacturer_matches: number; series_matches: number; model_matches: number;
  oi_cost_usd: number; provider_photos_without_cost: number;
};
// Monthly usage by company and month from recognition_run_records_monthly, read as the acting user
// so the table's RLS decides what is visible (OI staff: everything). month = 'YYYY-MM' or all months.
export async function recognitionRunRecordsMonthly(actorUserId: string, month?: string): Promise<RunRecordsMonthlyRow[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('oi.actor_user_id', $1, true)", [actorUserId]);
    const rows = (await c.query(`SELECT to_char(v.period_month,'YYYY-MM') AS period_month, v.organization_id, o.name AS organization_name, o.org_type, runs, photo_attempts,
        succeeded_photos, failed_photos, blocked_by_cap_photos, rejected_attempts, replayed_attempts, provider_photos, manufacturer_matches, series_matches, model_matches,
        oi_cost_usd, provider_photos_without_cost
      FROM recognition_run_records_monthly v JOIN organizations o ON o.id = v.organization_id
      WHERE ($1::date IS NULL OR v.period_month = $1::date)
      ORDER BY v.period_month DESC, o.name, v.organization_id LIMIT 5000`, [month ? month + '-01' : null])).rows;
    await c.query('COMMIT');
    return rows.map((r: any) => ({ ...r, oi_cost_usd: Number(r.oi_cost_usd) }));
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}