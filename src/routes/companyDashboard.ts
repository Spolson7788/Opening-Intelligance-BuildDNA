import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { facilityAccessPredicate } from "../db/tenantScope";
import { requireAuth, AuthedRequest, isMissingSchema } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { getObjectBytes } from "../services/storage";
import {
  ACCOUNT_KIND_NOTE, accountKind, accountKindLabel, attentionText, customerKey, groupCustomers,
  mayOpenCompanyDashboard, COMPANY_DASHBOARD_REFUSAL, type SiteRollup,
} from "../services/companyDashboard";

export const companyDashboardRouter = Router();
companyDashboardRouter.use(requireAuth, auditLog);

function refuseOffice(req: AuthedRequest, res: { status: (n: number) => { json: (b: unknown) => void } }): boolean {
  if (mayOpenCompanyDashboard(req.auth!.role)) return false;
  res.status(403).json({ error: "company_dashboard_forbidden", message: COMPANY_DASHBOARD_REFUSAL });
  return true;
}

function day(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function addressOf(row: { address_line1?: string | null; city?: string | null; state?: string | null }): string {
  return [row.address_line1, row.city, row.state].filter((part) => part && String(part).trim()).join(", ");
}

async function visibleProperties(orgId: string) {
  const sql = `SELECT p.id, p.name, p.address_line1, p.city, p.state,
      (pf.organization_id = $1) AS is_owner, owner.id AS owner_id, owner.name AS owner_name
    FROM properties p
    JOIN portfolios pf ON pf.id = p.portfolio_id
    JOIN organizations owner ON owner.id = pf.organization_id
    WHERE ${facilityAccessPredicate(1)}
    ORDER BY owner.name, p.name`;
  return pool.query(sql, [orgId]);
}

async function optionalQuery(sql: string, params: unknown[]) {
  try {
    return await pool.query(sql, params);
  } catch (error) {
    if (isMissingSchema(error)) return { rows: [] as any[] };
    throw error;
  }
}

async function rollups(propertyIds: string[]): Promise<Map<string, { openings: number; attention: number; lastVisit: string | null; nextDue: string | null }>> {
  const map = new Map<string, { openings: number; attention: number; lastVisit: string | null; nextDue: string | null }>();
  for (const id of propertyIds) map.set(id, { openings: 0, attention: 0, lastVisit: null, nextDue: null });
  if (!propertyIds.length) return map;
  const openings = await pool.query(
    `SELECT b.property_id, count(*)::int AS openings,
            count(*) FILTER (WHERE o.health_score IS NOT NULL AND o.health_score < 50)::int AS low_health
     FROM openings o JOIN buildings b ON b.id = o.building_id
     WHERE b.property_id = ANY($1::uuid[]) GROUP BY b.property_id`,
    [propertyIds],
  );
  for (const row of openings.rows) {
    const item = map.get(row.property_id);
    if (item) { item.openings = row.openings; item.attention = row.low_health; }
  }
  const overdue = await optionalQuery(
    `SELECT b.property_id, count(DISTINCT o.id)::int AS n
     FROM openings o JOIN buildings b ON b.id = o.building_id
     WHERE b.property_id = ANY($1::uuid[]) AND (
       EXISTS (SELECT 1 FROM work_orders wo WHERE wo.opening_id = o.id AND wo.status IN ('open','in_progress') AND wo.due_date < CURRENT_DATE)
       OR EXISTS (SELECT 1 FROM maintenance_schedules ms WHERE ms.opening_id = o.id AND ms.is_active AND ms.next_due_date < CURRENT_DATE)
     ) AND NOT (o.health_score IS NOT NULL AND o.health_score < 50)
     GROUP BY b.property_id`,
    [propertyIds],
  );
  for (const row of overdue.rows) {
    const item = map.get(row.property_id);
    if (item) item.attention += row.n;
  }
  const visits = await pool.query(
    `SELECT b.property_id, MAX(e.event_date) AS last_visit
     FROM service_events e JOIN openings o ON o.id = e.opening_id JOIN buildings b ON b.id = o.building_id
     WHERE b.property_id = ANY($1::uuid[]) GROUP BY b.property_id`,
    [propertyIds],
  );
  for (const row of visits.rows) {
    const item = map.get(row.property_id);
    if (item) item.lastVisit = day(row.last_visit);
  }
  const inspections = await optionalQuery(
    `SELECT b.property_id, MAX(i.event_date) AS last_visit
     FROM inspection_events i JOIN openings o ON o.id = i.opening_id JOIN buildings b ON b.id = o.building_id
     WHERE b.property_id = ANY($1::uuid[]) GROUP BY b.property_id`,
    [propertyIds],
  );
  for (const row of inspections.rows) {
    const item = map.get(row.property_id);
    if (!item) continue;
    const seen = day(row.last_visit);
    if (seen && (!item.lastVisit || seen > item.lastVisit)) item.lastVisit = seen;
  }
  const due = await optionalQuery(
    `SELECT b.property_id, MIN(ms.next_due_date) AS next_due
     FROM maintenance_schedules ms JOIN openings o ON o.id = ms.opening_id JOIN buildings b ON b.id = o.building_id
     WHERE ms.is_active AND b.property_id = ANY($1::uuid[]) GROUP BY b.property_id`,
    [propertyIds],
  );
  for (const row of due.rows) {
    const item = map.get(row.property_id);
    if (item) item.nextDue = day(row.next_due);
  }
  return map;
}

async function counts(orgId: string, propertyIds: string[]) {
  const empty = { open_work_orders: 0, failed_or_overdue: 0, inspections_due_30_days: 0, quotes: 0 };
  if (!propertyIds.length) return empty;
  const open = await optionalQuery(
    `SELECT count(*)::int AS n FROM work_orders wo
     JOIN openings o ON o.id = wo.opening_id JOIN buildings b ON b.id = o.building_id
     WHERE b.property_id = ANY($1::uuid[]) AND wo.status IN ('open','in_progress')`,
    [propertyIds],
  );
  const failed = await pool.query(
    `SELECT count(DISTINCT o.id)::int AS n FROM openings o JOIN buildings b ON b.id = o.building_id
     WHERE b.property_id = ANY($1::uuid[]) AND o.health_score IS NOT NULL AND o.health_score < 50`,
    [propertyIds],
  );
  const overdue = await optionalQuery(
    `SELECT count(DISTINCT o.id)::int AS n FROM openings o JOIN buildings b ON b.id = o.building_id
     WHERE b.property_id = ANY($1::uuid[]) AND NOT (o.health_score IS NOT NULL AND o.health_score < 50) AND (
       EXISTS (SELECT 1 FROM work_orders wo WHERE wo.opening_id = o.id AND wo.status IN ('open','in_progress') AND wo.due_date < CURRENT_DATE)
       OR EXISTS (SELECT 1 FROM maintenance_schedules ms WHERE ms.opening_id = o.id AND ms.is_active AND ms.next_due_date < CURRENT_DATE)
     )`,
    [propertyIds],
  );
  const due = await optionalQuery(
    `SELECT count(DISTINCT ms.opening_id)::int AS n FROM maintenance_schedules ms
     JOIN openings o ON o.id = ms.opening_id JOIN buildings b ON b.id = o.building_id
     WHERE ms.is_active AND b.property_id = ANY($1::uuid[])
       AND ms.next_due_date >= CURRENT_DATE AND ms.next_due_date <= CURRENT_DATE + 30`,
    [propertyIds],
  );
  const quotes = await optionalQuery(
    `SELECT count(*)::int AS n FROM replacement_estimates e
     JOIN openings o ON o.id = e.opening_id JOIN buildings b ON b.id = o.building_id
     WHERE e.provider_id = $2 AND b.property_id = ANY($1::uuid[])`,
    [propertyIds, orgId],
  );
  return {
    open_work_orders: open.rows[0]?.n ?? 0,
    failed_or_overdue: (failed.rows[0]?.n ?? 0) + (overdue.rows[0]?.n ?? 0),
    inspections_due_30_days: due.rows[0]?.n ?? 0,
    quotes: quotes.rows[0]?.n ?? 0,
  };
}

function sitesFrom(rows: any[], stats: Map<string, { openings: number; attention: number; lastVisit: string | null; nextDue: string | null }>): SiteRollup[] {
  return rows.map((row) => {
    const stat = stats.get(row.id);
    return {
      id: row.id,
      name: row.name,
      address: addressOf(row),
      isOwner: row.is_owner === true,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      openingCount: stat?.openings ?? 0,
      attentionCount: stat?.attention ?? 0,
      lastVisit: stat?.lastVisit ?? null,
      nextDue: stat?.nextDue ?? null,
    };
  });
}

async function loadSites(orgId: string) {
  const properties = await visibleProperties(orgId);
  const stats = await rollups(properties.rows.map((row) => row.id));
  return sitesFrom(properties.rows, stats);
}

companyDashboardRouter.get("/", async (req: AuthedRequest, res) => {
  if (refuseOffice(req, res)) return;
  try {
    const orgId = req.auth!.organizationId;
    const sites = await loadSites(orgId);
    const company = await pool.query("SELECT name FROM organizations WHERE id=$1", [orgId]);
    const summary = await counts(orgId, sites.map((site) => site.id));
    res.set("Cache-Control", "no-store").json({
      company_name: company.rows[0]?.name ?? "",
      classification_note: ACCOUNT_KIND_NOTE,
      counts: summary,
      customers: groupCustomers(sites),
    });
  } catch (error) {
    console.error("Company dashboard home failed", error);
    res.status(503).json({ error: "company_dashboard_unavailable" });
  }
});

companyDashboardRouter.get("/customers/:id", async (req: AuthedRequest, res) => {
  if (refuseOffice(req, res)) return;
  const id = req.params.id;
  try {
    const sites = await loadSites(req.auth!.organizationId);
    const match = sites.filter((site) => {
      const kind = accountKind(site.isOwner, site.name);
      return customerKey(kind, site.ownerId, site.id) === id || (kind === "facility" && site.ownerId === id);
    });
    if (!match.length) return res.status(404).json({ error: "not_found" });
    const kind = accountKind(match[0].isOwner, match[0].name);
    res.set("Cache-Control", "no-store").json({
      id,
      name: kind === "facility" ? match[0].ownerName : match[0].name,
      kind,
      kind_label: accountKindLabel(kind),
      classification_note: ACCOUNT_KIND_NOTE,
      sites: match.map((site) => ({
        id: site.id,
        name: site.name,
        address: site.address,
        opening_count: site.openingCount,
        attention: attentionText(site.attentionCount),
        last_visit: site.lastVisit,
        next_due: site.nextDue,
      })),
    });
  } catch (error) {
    console.error("Company dashboard customer failed", error);
    res.status(503).json({ error: "company_dashboard_unavailable" });
  }
});

async function propertyVisible(orgId: string, propertyId: string) {
  const row = await pool.query(
    `SELECT p.id, p.name, p.address_line1, p.city, p.state,
            (pf.organization_id = $2) AS is_owner, owner.id AS owner_id, owner.name AS owner_name
     FROM properties p
     JOIN portfolios pf ON pf.id = p.portfolio_id
     JOIN organizations owner ON owner.id = pf.organization_id
     WHERE p.id = $1 AND ${facilityAccessPredicate(2)}`,
    [propertyId, orgId],
  );
  return row.rows[0] ?? null;
}

companyDashboardRouter.get("/sites/:id", async (req: AuthedRequest, res) => {
  if (refuseOffice(req, res)) return;
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_site" });
  try {
    const property = await propertyVisible(req.auth!.organizationId, req.params.id);
    if (!property) return res.status(404).json({ error: "not_found" });
    const kind = accountKind(property.is_owner === true, property.name);
    const openings = await pool.query(
      `SELECT o.id, o.opening_code, o.location_description, o.opening_type, o.fire_rated, o.health_score, b.name AS building_name
       FROM openings o JOIN buildings b ON b.id = o.building_id
       WHERE b.property_id = $1 ORDER BY o.opening_code`,
      [property.id],
    );
    const visits = await optionalQuery(
      `SELECT v.id, to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS visit_date,
              v.report_storage_key IS NOT NULL AS report_stored
       FROM inspection_visits v WHERE v.property_id = $1 ORDER BY v.created_at DESC LIMIT 50`,
      [property.id],
    );
    const work = await optionalQuery(
      `SELECT wo.id, wo.title, wo.status, wo.due_date, o.opening_code
       FROM work_orders wo JOIN openings o ON o.id = wo.opening_id JOIN buildings b ON b.id = o.building_id
       WHERE b.property_id = $1 AND wo.status IN ('open','in_progress')
       ORDER BY wo.due_date NULLS LAST, wo.created_at DESC LIMIT 50`,
      [property.id],
    );
    const quotes = await optionalQuery(
      `SELECT e.id, o.opening_code, o.id AS opening_id, v.snapshot
       FROM replacement_estimates e
       JOIN openings o ON o.id = e.opening_id
       JOIN buildings b ON b.id = o.building_id
       LEFT JOIN replacement_estimate_versions v ON v.estimate_id = e.id AND v.version = e.head_version
       WHERE b.property_id = $1 AND e.provider_id = $2
       ORDER BY o.opening_code`,
      [property.id, req.auth!.organizationId],
    );
    res.set("Cache-Control", "no-store").json({
      id: property.id,
      name: property.name,
      address: addressOf(property),
      kind,
      kind_label: accountKindLabel(kind),
      customer_id: customerKey(kind, property.owner_id, property.id),
      customer_name: kind === "facility" ? property.owner_name : property.name,
      openings: openings.rows.map((row) => ({
        ...row,
        needs_attention: row.health_score !== null && Number(row.health_score) < 50,
      })),
      visits: visits.rows,
      work_orders: work.rows.map((row) => ({ ...row, due_date: day(row.due_date) })),
      quotes: quotes.rows.map((row) => ({
        id: row.id,
        opening_id: row.opening_id,
        opening_code: row.opening_code,
        total_minor: row.snapshot?.totals?.total_minor ?? null,
      })),
    });
  } catch (error) {
    console.error("Company dashboard site failed", error);
    res.status(503).json({ error: "company_dashboard_unavailable" });
  }
});

companyDashboardRouter.get("/openings/:id", async (req: AuthedRequest, res) => {
  if (refuseOffice(req, res)) return;
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_opening" });
  try {
    const opening = await pool.query(
      `SELECT o.*, b.name AS building_name, p.id AS property_id, p.name AS property_name, p.address_line1, p.city, p.state,
              (pf.organization_id = $2) AS is_owner, owner.id AS owner_id, owner.name AS owner_name
       FROM openings o
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       JOIN organizations owner ON owner.id = pf.organization_id
       WHERE o.id = $1 AND ${facilityAccessPredicate(2)}`,
      [req.params.id, req.auth!.organizationId],
    );
    const row = opening.rows[0];
    if (!row) return res.status(404).json({ error: "not_found" });
    const kind = accountKind(row.is_owner === true, row.property_name);
    let records: any[] = [];
    try {
      const service = await pool.query(
        `SELECT e.id, 'service' AS kind, e.work_performed AS label, e.event_date AS performed_on,
                (SELECT MIN((sr.created_at AT TIME ZONE 'UTC')::date)
                 FROM service_requests sr
                 JOIN service_request_targets t ON t.request_id = sr.id
                 WHERE sr.opening_id = e.opening_id
                   AND e.hardware_component_id IS NOT NULL
                   AND t.hardware_component_id = e.hardware_component_id
                   AND (sr.created_at AT TIME ZONE 'UTC')::date <= e.event_date) AS advised_on
         FROM service_events e WHERE e.opening_id = $1 ORDER BY e.event_date DESC`,
        [row.id],
      );
      records = service.rows;
    } catch (error) {
      if (!isMissingSchema(error)) throw error;
      const service = await pool.query(
        `SELECT e.id, 'service' AS kind, e.work_performed AS label, e.event_date AS performed_on, NULL::date AS advised_on
         FROM service_events e WHERE e.opening_id = $1 ORDER BY e.event_date DESC`,
        [row.id],
      );
      records = service.rows;
    }
    const quotes = await optionalQuery(
      `SELECT e.id, v.snapshot FROM replacement_estimates e
       LEFT JOIN replacement_estimate_versions v ON v.estimate_id = e.id AND v.version = e.head_version
       WHERE e.opening_id = $1 AND e.provider_id = $2`,
      [row.id, req.auth!.organizationId],
    );
    res.set("Cache-Control", "no-store").json({
      id: row.id,
      opening_code: row.opening_code,
      location_description: row.location_description,
      opening_type: row.opening_type,
      fire_rated: row.fire_rated,
      health_score: row.health_score,
      needs_attention: row.health_score !== null && Number(row.health_score) < 50,
      building_name: row.building_name,
      property_id: row.property_id,
      property_name: row.property_name,
      address: addressOf(row),
      kind,
      kind_label: accountKindLabel(kind),
      customer_id: customerKey(kind, row.owner_id, row.property_id),
      customer_name: kind === "facility" ? row.owner_name : row.property_name,
      work_records: records.map((item) => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        performed_on: day(item.performed_on),
        advised_on: day(item.advised_on),
      })),
      quotes: quotes.rows.map((item) => ({ id: item.id, total_minor: item.snapshot?.totals?.total_minor ?? null })),
    });
  } catch (error) {
    console.error("Company dashboard opening failed", error);
    res.status(503).json({ error: "company_dashboard_unavailable" });
  }
});

companyDashboardRouter.get("/visits/:visitId/report.pdf", async (req: AuthedRequest, res) => {
  if (refuseOffice(req, res)) return;
  if (!z.string().uuid().safeParse(req.params.visitId).success) return res.status(400).json({ error: "invalid_visit" });
  try {
    const stored = await pool.query(
      `SELECT v.report_storage_key
       FROM inspection_visits v
       JOIN properties p ON p.id = v.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE v.id = $1 AND v.report_storage_key IS NOT NULL AND ${facilityAccessPredicate(2)}`,
      [req.params.visitId, req.auth!.organizationId],
    );
    const key = stored.rows[0]?.report_storage_key;
    if (!key) return res.status(404).json({ error: "not_found" });
    const bytes = await getObjectBytes(key, 20 * 1024 * 1024);
    res.set("Content-Type", "application/pdf").set("Cache-Control", "no-store").send(Buffer.from(bytes));
  } catch (error) {
    if (isMissingSchema(error)) return res.status(404).json({ error: "not_found" });
    console.error("Company dashboard visit PDF failed", error);
    res.status(503).json({ error: "company_dashboard_unavailable" });
  }
});
