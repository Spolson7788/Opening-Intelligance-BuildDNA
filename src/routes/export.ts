import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery } from "../db/tenantScope";
import { toCsv } from "../services/csv";
import { generateComplianceReportPdf } from "../services/complianceReport";
import { generateCapitalForecastPdf } from "../services/capitalForecastReport";

export const exportRouter = Router();
exportRouter.use(requireAuth);
exportRouter.use(enforceRolePermissions);
exportRouter.use(auditLog);

// Fire door / life-safety compliance PDF — the artifact a facilities manager
// can actually hand to an auditor or fire marshal, unlike a CSV. Scoped to
// one property (a report spanning a whole multi-property portfolio isn't
// what anyone hands to an inspector). Defaults to fire-rated/life-safety
// openings only, since that's what a compliance review actually cares about;
// ?scope=all includes everything.
exportRouter.get("/compliance-report.pdf", async (req: AuthedRequest, res) => {
  const { property_id, scope } = req.query;
  const orgId = req.auth!.organizationId;

  if (!property_id || typeof property_id !== "string") {
    return res.status(400).json({ error: "property_id is required" });
  }

  try {
    const propertyResult = await pool.query(
      `SELECT p.name, p.address_line1, p.city, p.state, p.postal_code
       FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE p.id = $1 AND pf.organization_id = $2`,
      [property_id, orgId]
    );
    if (propertyResult.rows.length === 0) return res.status(403).json({ error: "forbidden" });
    const property = propertyResult.rows[0];

    const scopeFilter = scope === "all" ? "" : "AND (o.fire_rated = true OR o.life_safety_critical = true)";

    const openingsResult = await pool.query(
      `SELECT
         o.opening_code, b.name AS building_name, o.floor_label, o.location_description,
         o.fire_rated, o.life_safety_critical, o.health_score,
         li.event_date AS last_inspection_date, li.passed AS last_inspection_passed,
         li.notes AS last_inspection_notes, li.inspection_type, li.signed_by_name AS last_inspection_signed_by,
         COALESCE(ph.photo_count, 0) AS photo_count
       FROM openings o
       JOIN buildings b ON b.id = o.building_id
       LEFT JOIN LATERAL (
         SELECT event_date, passed, notes, inspection_type, signed_by_name
         FROM inspection_events WHERE opening_id = o.id
         ORDER BY event_date DESC LIMIT 1
       ) li ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS photo_count FROM photos WHERE opening_id = o.id
       ) ph ON true
       WHERE b.property_id = $1 ${scopeFilter}
       ORDER BY b.name, o.opening_code`,
      [property_id]
    );

    if (openingsResult.rows.length === 0) {
      return res.status(404).json({
        error: "no_openings_in_scope",
        detail: "No fire-rated or life-safety-critical openings found for this property. Try ?scope=all.",
      });
    }

    const addressParts = [property.address_line1, property.city, property.state, property.postal_code].filter(Boolean);

    const pdfBuffer = await generateComplianceReportPdf({
      propertyName: property.name,
      propertyAddress: addressParts.length > 0 ? addressParts.join(", ") : null,
      generatedAt: new Date(),
      openings: openingsResult.rows,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="compliance-report-${property.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf"`
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const DEFAULT_FORECAST_COSTS: Record<string, number> = {
  door: 800, overhead_door: 3500, loading_dock: 4000,
  gate: 1200, automatic_entrance: 2500, access_control_point: 600,
};

const FORECAST_BUCKET_DEFS = [
  { key: "urgent", label: "Urgent — replace within 1 year" },
  { key: "near_term", label: "Near-term — 2-3 years" },
  { key: "healthy", label: "Healthy — no near-term replacement needed" },
  { key: "unassessed", label: "Not yet assessed" },
] as const;

// Same underlying bucketing logic as GET /api/portfolio/capital-forecast and
// its /rollup sibling, queried independently here rather than importing from
// portfolio.ts — matches how the compliance report queries independently of
// the dashboard's fetch logic rather than coupling across route files.
// Cost assumptions are passed as a URL-encoded JSON query param so the PDF
// reflects whatever the user currently has dialed in on the dashboard,
// falling back to the same defaults the dashboard starts with.
exportRouter.get("/capital-forecast.pdf", async (req: AuthedRequest, res) => {
  const { property_id, costs: costsParam } = req.query;
  const orgId = req.auth!.organizationId;

  let costs = DEFAULT_FORECAST_COSTS;
  if (costsParam && typeof costsParam === "string") {
    try {
      costs = { ...DEFAULT_FORECAST_COSTS, ...JSON.parse(costsParam) };
    } catch {
      return res.status(400).json({ error: "invalid_costs_param" });
    }
  }

  try {
    if (property_id && typeof property_id === "string") {
      const propertyResult = await pool.query(
        `SELECT p.name FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
         WHERE p.id = $1 AND pf.organization_id = $2`,
        [property_id, orgId]
      );
      if (propertyResult.rows.length === 0) return res.status(403).json({ error: "forbidden" });

      const result = await pool.query(
        `WITH opening_bucket AS (
           SELECT o.id, o.opening_type,
             CASE
               WHEN o.health_score IS NULL THEN 'unassessed'
               WHEN o.health_score < 50 THEN 'urgent'
               WHEN o.health_score < 75 THEN 'near_term'
               ELSE 'healthy'
             END AS bucket
           FROM openings o JOIN buildings b ON b.id = o.building_id
           WHERE b.property_id = $1
         ),
         opening_known_cost AS (
           SELECT ob.id, ob.opening_type, ob.bucket,
             COALESCE(SUM(hc.unit_cost), 0) AS known_cost,
             COUNT(hc.id) FILTER (WHERE hc.unit_cost IS NOT NULL) AS priced_parts
           FROM opening_bucket ob
           LEFT JOIN hardware_components hc ON hc.opening_id = ob.id
           GROUP BY ob.id, ob.opening_type, ob.bucket
         )
         SELECT bucket, opening_type,
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE priced_parts = 0)::int AS count_needing_estimate,
           COALESCE(SUM(known_cost), 0) AS known_cost_total
         FROM opening_known_cost GROUP BY bucket, opening_type`,
        [property_id]
      );

      const buckets: Record<string, any> = {};
      for (const b of FORECAST_BUCKET_DEFS) buckets[b.key] = { label: b.label, total: 0, known_cost_total: 0, needing_estimate_by_type: {} };
      let totalOpenings = 0;
      for (const row of result.rows) {
        buckets[row.bucket].total += row.total_count;
        buckets[row.bucket].known_cost_total += Number(row.known_cost_total);
        if (row.count_needing_estimate > 0) buckets[row.bucket].needing_estimate_by_type[row.opening_type] = row.count_needing_estimate;
        totalOpenings += row.total_count;
      }

      const pdfBuffer = await generateCapitalForecastPdf({
        mode: "single_property",
        propertyName: propertyResult.rows[0].name,
        generatedAt: new Date(),
        totalOpenings,
        buckets,
        costs,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="capital-forecast-${propertyResult.rows[0].name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf"`);
      res.send(pdfBuffer);
    } else {
      const result = await pool.query(
        `WITH opening_bucket AS (
           SELECT o.id, o.opening_type, p.id AS property_id, p.name AS property_name,
             CASE
               WHEN o.health_score IS NULL THEN 'unassessed'
               WHEN o.health_score < 50 THEN 'urgent'
               WHEN o.health_score < 75 THEN 'near_term'
               ELSE 'healthy'
             END AS bucket
           FROM openings o
           JOIN buildings b ON b.id = o.building_id
           JOIN properties p ON p.id = b.property_id
           JOIN portfolios pf ON pf.id = p.portfolio_id
           WHERE pf.organization_id = $1
         ),
         opening_known_cost AS (
           SELECT ob.id, ob.opening_type, ob.property_id, ob.property_name, ob.bucket,
             COALESCE(SUM(hc.unit_cost), 0) AS known_cost,
             COUNT(hc.id) FILTER (WHERE hc.unit_cost IS NOT NULL) AS priced_parts
           FROM opening_bucket ob
           LEFT JOIN hardware_components hc ON hc.opening_id = ob.id
           GROUP BY ob.id, ob.opening_type, ob.property_id, ob.property_name, ob.bucket
         )
         SELECT property_id, property_name, bucket, opening_type,
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE priced_parts = 0)::int AS count_needing_estimate,
           COALESCE(SUM(known_cost), 0) AS known_cost_total
         FROM opening_known_cost GROUP BY property_id, property_name, bucket, opening_type`,
        [orgId]
      );

      const propertiesById: Record<string, any> = {};
      for (const row of result.rows) {
        if (!propertiesById[row.property_id]) {
          propertiesById[row.property_id] = {
            propertyName: row.property_name,
            totalOpenings: 0,
            buckets: Object.fromEntries(FORECAST_BUCKET_DEFS.map((b) => [b.key, { label: b.label, total: 0, known_cost_total: 0, needing_estimate_by_type: {} }])),
          };
        }
        const p = propertiesById[row.property_id];
        p.buckets[row.bucket].total += row.total_count;
        p.buckets[row.bucket].known_cost_total += Number(row.known_cost_total);
        if (row.count_needing_estimate > 0) p.buckets[row.bucket].needing_estimate_by_type[row.opening_type] = row.count_needing_estimate;
        p.totalOpenings += row.total_count;
      }

      const pdfBuffer = await generateCapitalForecastPdf({
        mode: "portfolio_rollup",
        generatedAt: new Date(),
        properties: Object.values(propertiesById),
        costs,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="capital-forecast-portfolio-${new Date().toISOString().slice(0, 10)}.pdf"`);
      res.send(pdfBuffer);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const OPENINGS_COLUMNS = [
  "opening_code", "property_name", "building_name", "floor_label", "location_description",
  "opening_type", "fire_rated", "life_safety_critical", "health_score",
  "install_date", "last_service_date", "status",
];

// Same filter shape as GET /api/openings, so "export what I'm currently
// looking at" behaves exactly like the dashboard's filter state.
exportRouter.get("/openings.csv", async (req: AuthedRequest, res) => {
  const { building_id, property_id, opening_type, max_health_score } = req.query;
  const orgId = req.auth!.organizationId;
  const conditions: string[] = [];
  const values: any[] = [];

  if (building_id) {
    values.push(building_id);
    conditions.push(`o.building_id = $${values.length}`);
  }
  if (property_id) {
    values.push(property_id);
    conditions.push(`o.building_id IN (SELECT id FROM buildings WHERE property_id = $${values.length})`);
  }
  if (opening_type) {
    values.push(opening_type);
    conditions.push(`o.opening_type = $${values.length}`);
  }
  if (max_health_score) {
    values.push(max_health_score);
    conditions.push(`o.health_score <= $${values.length}`);
  }
  values.push(orgId);
  conditions.push(`o.id IN (${openingsForOrgSubquery(values.length)})`);

  try {
    const result = await pool.query(
      `SELECT
         o.opening_code, p.name AS property_name, b.name AS building_name,
         o.floor_label, o.location_description, o.opening_type,
         o.fire_rated, o.life_safety_critical, o.health_score,
         o.install_date, o.last_service_date, o.status
       FROM openings o
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.name, b.name, o.opening_code
       LIMIT 10000`,
      values
    );

    const csv = toCsv(result.rows, OPENINGS_COLUMNS);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="openings-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const HARDWARE_COLUMNS = [
  "opening_code", "property_name", "building_name", "component_type",
  "manufacturer", "model_number", "finish", "install_date", "warranty_expiration",
];

// Pairs with the hardware search endpoint: "find every Cal-Royal cylinder
// installed before 2019" is a search; this is what turns that search into
// something you can hand to a capital planning spreadsheet.
exportRouter.get("/hardware.csv", async (req: AuthedRequest, res) => {
  const { manufacturer, model_number, component_type } = req.query;
  const orgId = req.auth!.organizationId;
  const conditions: string[] = [];
  const values: any[] = [];

  if (manufacturer) {
    values.push(`%${manufacturer}%`);
    conditions.push(`hc.manufacturer ILIKE $${values.length}`);
  }
  if (model_number) {
    values.push(`%${model_number}%`);
    conditions.push(`hc.model_number ILIKE $${values.length}`);
  }
  if (component_type) {
    values.push(component_type);
    conditions.push(`hc.component_type = $${values.length}`);
  }
  values.push(orgId);
  conditions.push(`hc.opening_id IN (${openingsForOrgSubquery(values.length)})`);

  try {
    const result = await pool.query(
      `SELECT
         o.opening_code, p.name AS property_name, b.name AS building_name,
         hc.component_type, hc.manufacturer, hc.model_number, hc.finish,
         hc.install_date, hc.warranty_expiration
       FROM hardware_components hc
       JOIN openings o ON o.id = hc.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.name, b.name, o.opening_code
       LIMIT 10000`,
      values
    );

    const csv = toCsv(result.rows, HARDWARE_COLUMNS);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hardware-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
