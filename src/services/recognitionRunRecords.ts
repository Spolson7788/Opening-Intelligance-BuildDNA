import { pool } from '../db/pool';
import type { Identity } from './recognitionRuns';
// Recognition run records (Oct 31 2026 milestone; DRAFT migration 20261031090000, not applied).
// One row per photo per attempt, written for EVERY attempt that created a run: success, failure and
// refusal by the emergency safety cap. Append-only, RLS-scoped (see the migration header).

export type RecordStatus = 'succeeded' | 'failed' | 'blocked_by_cap';
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

export async function writeRunRecords(a: {
  runId: string; organizationId: string; propertyId: string; openingId: string; photoIds: string[];
  runStatus: string; failureCode: string | null; result: unknown; identity: Identity | null; providerCalled: boolean;
}): Promise<void> {
  const status = recordStatus(a.runStatus);
  const m = status === 'succeeded' ? matchedLevels(a.result, a.identity) : matchedLevels(null, null);
  const failure = status === 'succeeded' ? null : (a.failureCode ?? 'unknown_failure');
  await pool.query(`INSERT INTO recognition_run_records(run_id,organization_id,property_id,opening_id,photo_id,status,failure_code,
      manufacturer,manufacturer_confidence,series,series_confidence,model,model_confidence,model_marking_evidence,provider_called,cost_per_photo_usd)
    SELECT $1,$2,$3,$4,pid,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,(SELECT cost_per_photo_usd FROM recognition_usage_settings WHERE id)
    FROM unnest($5::uuid[]) AS pid ON CONFLICT (run_id, photo_id) DO NOTHING`,
    [a.runId, a.organizationId, a.propertyId, a.openingId, a.photoIds, status, failure,
      m.manufacturer, m.manufacturer_confidence, m.series, m.series_confidence, m.model, m.model_confidence, m.model_marking_evidence,
      status === 'blocked_by_cap' ? false : a.providerCalled]);
}

export type RunRecordsMonthlyRow = {
  period_month: string; organization_id: string; organization_name: string; org_type: string;
  runs: number; photo_attempts: number; succeeded_photos: number; failed_photos: number; blocked_by_cap_photos: number;
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
        succeeded_photos, failed_photos, blocked_by_cap_photos, provider_photos, manufacturer_matches, series_matches, model_matches,
        oi_cost_usd, provider_photos_without_cost
      FROM recognition_run_records_monthly v JOIN organizations o ON o.id = v.organization_id
      WHERE ($1::date IS NULL OR v.period_month = $1::date)
      ORDER BY v.period_month DESC, o.name, v.organization_id LIMIT 5000`, [month ? month + '-01' : null])).rows;
    await c.query('COMMIT');
    return rows.map((r: any) => ({ ...r, oi_cost_usd: Number(r.oi_cost_usd) }));
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}