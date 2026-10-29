import { pool } from '../db/pool';
// OI-staff-only recognition usage report (revised Oct 29, 11:17 decision). Read-only.
// Billing model: $0.75 (settings.opening_price_cents_per_month) per opening per month, billed to BOTH
// the service provider that ran recognition on the opening and the facility owner. An opening is
// billable to a company in a month when at least one COUNTED run (one that reached the provider) on
// it was requested by that company or sits in a facility that company owns. When the facility runs
// its own recognition it is billed once. Recognition cost is counted once per opening (shared
// openings appear in both companies' rows; the totals count the cost once and revenue per company).
export type UsageCompanyRow = {
  organization_id: string; organization_name: string; org_type: string;
  billable_openings: number; revenue_cents: number;
  photos_recognized: number; runs: number;
  recognition_cost_usd: number | null; cost_per_opening_usd: number | null;
  requested_photos: number; requested_runs: number;
  safety_cap_photos: number; cap_used_ratio: number; cap_warning: boolean;
};
export type UsageReport = {
  month: string;
  settings: { opening_price_cents_per_month: number; cost_per_photo_usd: number | null; default_monthly_photo_cap: number; cap_warning_ratio: number };
  companies: UsageCompanyRow[];
  totals: { distinct_openings: number; photos_recognized: number; runs: number; recognition_cost_usd: number | null; revenue_cents: number; cost_per_opening_usd: number | null };
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
  const rows = (await pool.query(`
    WITH counted AS (
      SELECT r.opening_id, r.organization_id AS requester, pf.organization_id AS owner, u.photo_count AS n
      FROM recognition_usage_reservations u JOIN recognition_runs r ON r.id = u.run_id
      JOIN properties p ON p.id = r.property_id JOIN portfolios pf ON pf.id = p.portfolio_id
      WHERE u.period_month = $1::date),
    per_opening AS (SELECT opening_id, sum(n)::int AS photos, count(*)::int AS runs FROM counted GROUP BY opening_id),
    billed AS (SELECT DISTINCT org, opening_id FROM (SELECT requester AS org, opening_id FROM counted UNION SELECT owner, opening_id FROM counted) x),
    per_company AS (SELECT b.org, count(*)::int AS openings, sum(po.photos)::int AS photos, sum(po.runs)::int AS runs
      FROM billed b JOIN per_opening po USING (opening_id) GROUP BY b.org),
    requested AS (SELECT organization_id AS org, photos_counted, runs_counted FROM recognition_usage_monthly WHERE period_month = $1::date),
    orgs AS (SELECT org FROM per_company UNION SELECT org FROM requested)
    SELECT o.id AS organization_id, o.name AS organization_name, o.org_type,
      COALESCE(pc.openings,0) AS billable_openings, COALESCE(pc.photos,0) AS photos_recognized, COALESCE(pc.runs,0) AS runs,
      COALESCE(rq.photos_counted,0) AS requested_photos, COALESCE(rq.runs_counted,0) AS requested_runs,
      COALESCE(c.monthly_photo_cap, $2::int) AS safety_cap_photos
    FROM orgs JOIN organizations o ON o.id = orgs.org
    LEFT JOIN per_company pc ON pc.org = o.id LEFT JOIN requested rq ON rq.org = o.id
    LEFT JOIN recognition_safety_caps c ON c.organization_id = o.id
    ORDER BY o.name, o.id`, [period, settings.default_monthly_photo_cap])).rows;
  const totals = (await pool.query(`SELECT count(DISTINCT r.opening_id)::int AS openings, COALESCE(sum(u.photo_count),0)::int AS photos, count(*)::int AS runs
    FROM recognition_usage_reservations u JOIN recognition_runs r ON r.id = u.run_id WHERE u.period_month = $1::date`, [period])).rows[0];
  const cost = (photos: number) => settings.cost_per_photo_usd == null ? null : round6(photos * settings.cost_per_photo_usd);
  const companies: UsageCompanyRow[] = rows.map((r: any) => {
    const c = cost(r.photos_recognized), ratio = r.safety_cap_photos > 0 ? r.requested_photos / r.safety_cap_photos : 0;
    return { ...r, revenue_cents: r.billable_openings * settings.opening_price_cents_per_month, recognition_cost_usd: c,
      cost_per_opening_usd: c == null || !r.billable_openings ? null : round6(c / r.billable_openings),
      cap_used_ratio: Math.round(ratio * 10000) / 10000, cap_warning: ratio >= settings.cap_warning_ratio };
  });
  const totalCost = cost(totals.photos);
  return { month, settings, companies, totals: {
    distinct_openings: totals.openings, photos_recognized: totals.photos, runs: totals.runs, recognition_cost_usd: totalCost,
    revenue_cents: companies.reduce((n, c) => n + c.revenue_cents, 0),
    cost_per_opening_usd: totalCost == null || !totals.openings ? null : round6(totalCost / totals.openings) } };
}
