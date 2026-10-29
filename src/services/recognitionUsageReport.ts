import { pool } from '../db/pool';
// OI-staff-only monthly usage and billing report (Oct 29 11:42 decision). Read-only.
// Billing (11:42 + 11:56 decisions): settings.opening_price_cents_per_month ($0.75) per BILLABLE opening
// per month, whether or not recognition ran. Full month for any overlap (no proration).
//  - BILLABLE = status 'active' (captured). 'pending_capture' placeholders and decommissioned openings
//    do not bill. History is opening_billable_periods (kept even after the opening/facility is deleted;
//    owner and facility are the snapshot taken when the period started).
//  - The facility owner pays for each opening with a billable period overlapping the month.
//  - Each assigned provider pays for an opening only if a billable period of the opening overlaps one
//    of its assignment periods for the facility INSIDE the month (not for openings added after it left).
//  - A provider's own facility is billed once, to the provider.
// Recognition cost per photo is OI's INTERNAL cost (never billed), attributed to the company that
// requested the counted run, so totals add up without double counting. Margin = revenue - cost.
export type UsageCompanyRow = {
  organization_id: string; organization_name: string; org_type: string;
  owned_openings: number; provider_openings: number; billable_openings: number; revenue_cents: number;
  photos_recognized: number; runs: number;
  oi_recognition_cost_usd: number | null; margin_usd: number | null;
  safety_cap_photos: number; cap_used_ratio: number; cap_warning: boolean;
};
export type UsageReport = {
  month: string;
  settings: { opening_price_cents_per_month: number; cost_per_photo_usd: number | null; default_monthly_photo_cap: number; cap_warning_ratio: number };
  companies: UsageCompanyRow[];
  totals: { active_openings: number; billable_openings: number; revenue_cents: number; photos_recognized: number; runs: number; oi_recognition_cost_usd: number | null; margin_usd: number | null };
};
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function recognitionUsageReport(month: string): Promise<UsageReport> {
  const period = month + '-01';
  const s = (await pool.query('SELECT opening_price_cents_per_month, cost_per_photo_usd, default_monthly_photo_cap, cap_warning_ratio FROM recognition_usage_settings WHERE id')).rows[0];
  const settings = {
    opening_price_cents_per_month: Number(s?.opening_price_cents_per_month ?? 75),
    cost_per_photo_usd: s?.cost_per_photo_usd == null ? null : Number(s.cost_per_photo_usd),
    default_monthly_photo_cap: Number(s?.default_monthly_photo_cap ?? 80000),
    cap_warning_ratio: Number(s?.cap_warning_ratio ?? 0.8),
  };
  const q = (await pool.query(`
    WITH bounds AS (SELECT $1::date::timestamptz AS m0, ($1::date + interval '1 month')::timestamptz AS m1),
    op AS (  -- billable periods clipped to the month
      SELECT bp.opening_id, bp.property_id, bp.owner_organization_id AS owner,
        greatest(bp.started_at, bounds.m0) AS s, least(COALESCE(bp.ended_at, bounds.m1), bounds.m1) AS e
      FROM opening_billable_periods bp CROSS JOIN bounds
      WHERE bp.started_at < bounds.m1 AND (bp.ended_at IS NULL OR bp.ended_at > bounds.m0)),
    active AS (SELECT DISTINCT opening_id, owner FROM op),
    ap AS (
      SELECT a.property_id, a.provider_organization_id AS org,
        greatest(a.started_at, bounds.m0) AS s, least(COALESCE(a.ended_at, bounds.m1), bounds.m1) AS e
      FROM facility_provider_assignment_periods a CROSS JOIN bounds
      WHERE a.started_at < bounds.m1 AND (a.ended_at IS NULL OR a.ended_at > bounds.m0)),
    billed AS (
      SELECT owner AS org, opening_id, true AS owned FROM active
      UNION
      SELECT ap.org, op.opening_id, false FROM op JOIN ap ON ap.property_id = op.property_id
       WHERE ap.org <> op.owner AND greatest(op.s, ap.s) < least(op.e, ap.e)),
    per_company AS (SELECT org, count(*) FILTER (WHERE owned)::int AS owned, count(*) FILTER (WHERE NOT owned)::int AS provided FROM billed GROUP BY org),
    requested AS (SELECT organization_id AS org, photos_counted, runs_counted FROM recognition_usage_monthly WHERE period_month = $1::date),
    orgs AS (SELECT org FROM per_company UNION SELECT org FROM requested)
    SELECT o.id AS organization_id, o.name AS organization_name, o.org_type,
      COALESCE(pc.owned,0) AS owned_openings, COALESCE(pc.provided,0) AS provider_openings,
      COALESCE(rq.photos_counted,0) AS photos_recognized, COALESCE(rq.runs_counted,0) AS runs,
      COALESCE(c.monthly_photo_cap, $2::int) AS safety_cap_photos,
      (SELECT count(DISTINCT opening_id) FROM active)::int AS active_total
    FROM orgs JOIN organizations o ON o.id = orgs.org AND o.org_type <> 'internal'
    LEFT JOIN per_company pc ON pc.org = o.id LEFT JOIN requested rq ON rq.org = o.id
    LEFT JOIN recognition_safety_caps c ON c.organization_id = o.id
    ORDER BY o.name, o.id`, [period, settings.default_monthly_photo_cap])).rows;
  const active = q.length ? Number(q[0].active_total) : 0;
  const cost = (photos: number) => settings.cost_per_photo_usd == null ? null : round6(photos * settings.cost_per_photo_usd);
  const companies: UsageCompanyRow[] = q.map(({ active_total: _a, ...r }: any) => {
    const billable = r.owned_openings + r.provider_openings, revenue = billable * settings.opening_price_cents_per_month;
    const c = cost(r.photos_recognized), ratio = r.safety_cap_photos > 0 ? r.photos_recognized / r.safety_cap_photos : 0;
    return { ...r, billable_openings: billable, revenue_cents: revenue, oi_recognition_cost_usd: c,
      margin_usd: c == null ? null : round6(revenue / 100 - c),
      cap_used_ratio: Math.round(ratio * 10000) / 10000, cap_warning: ratio >= settings.cap_warning_ratio };
  });
  const sum = (f: (c: UsageCompanyRow) => number) => companies.reduce((n, c) => n + f(c), 0);
  const revenue = sum((c) => c.revenue_cents), photos = sum((c) => c.photos_recognized), totalCost = cost(photos);
  return { month, settings, companies, totals: {
    active_openings: active, billable_openings: sum((c) => c.billable_openings), revenue_cents: revenue,
    photos_recognized: photos, runs: sum((c) => c.runs), oi_recognition_cost_usd: totalCost,
    margin_usd: totalCost == null ? null : round6(revenue / 100 - totalCost) } };
}
