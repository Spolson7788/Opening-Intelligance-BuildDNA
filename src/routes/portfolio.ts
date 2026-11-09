import { customerMayOpenFacilityDashboard } from "../services/facilityDashboardAccess";
import { databaseRoute } from '../db/databaseRoute';
import { facilityAccessPredicate, photoVisibleSql, serviceEventVisibleSql, facilityAccessPredicateAny, allowedOrgIds, orgScope } from "../db/tenantScope";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest, isMissingSchema } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);
portfolioRouter.use(enforceRolePermissions);
portfolioRouter.use(auditLog);

async function facilityDashboardAllowed(req: AuthedRequest): Promise<boolean> {
  const org = await pool.query("SELECT org_type FROM organizations WHERE id=$1", [req.auth!.organizationId]);
  return customerMayOpenFacilityDashboard(org.rows[0]?.org_type, req.auth!.role);
}

// Checked before any facility list or opening payload. Unknown, loading, and revoked
// sessions are already denied by requireAuth. This route adds the customer office role.
portfolioRouter.get("/facility-dashboard-access", async (req: AuthedRequest, res) => {
  try {
    if (!await facilityDashboardAllowed(req)) return res.status(403).json({ error: "facility_dashboard_forbidden" });
    res.set("Cache-Control", "no-store").json({ allowed: true });
  } catch {
    res.status(503).json({ error: "facility_dashboard_unavailable" });
  }
});

// One statement gives the customer Dashboard a consistent read of the same
// records written by the Field App. No mirrored database or client-side grants.
portfolioRouter.get("/facility-dashboard/:id", async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_facility" });
  try {
    if (!await facilityDashboardAllowed(req)) return res.status(403).json({ error: "facility_dashboard_forbidden" });
    const result = await pool.query(`
      SELECT p.*, COALESCE((
        SELECT jsonb_agg(to_jsonb(o) || jsonb_build_object(
          'building_name', b.name,
          'frame', (SELECT to_jsonb(f) FROM opening_frames f WHERE f.opening_id=o.id),
          'door_leaves', COALESCE((SELECT jsonb_agg(l ORDER BY l.leaf_role) FROM door_leaves l WHERE l.opening_id=o.id),'[]'::jsonb),
          'hardware_components', COALESCE((SELECT jsonb_agg(h ORDER BY h.id) FROM current_hardware_components h WHERE h.opening_id=o.id),'[]'::jsonb),
          'retired_hardware_components', COALESCE((SELECT jsonb_agg(h ORDER BY h.id) FROM hardware_components h WHERE h.opening_id=o.id AND h.lifecycle_state='retired'),'[]'::jsonb),
          'service_events', COALESCE((SELECT jsonb_agg(e ORDER BY e.event_date DESC,e.id) FROM service_events e WHERE e.opening_id=o.id AND ${serviceEventVisibleSql('e', 2)}),'[]'::jsonb),
          'inspection_events', COALESCE((SELECT jsonb_agg(i ORDER BY i.event_date DESC,i.id) FROM inspection_events i WHERE i.opening_id=o.id),'[]'::jsonb),
          'photos', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', ph.id, 'related_entity_type', ph.related_entity_type,
            'related_entity_id', ph.related_entity_id, 'created_at', ph.created_at
          ) ORDER BY ph.created_at,ph.id) FROM photos ph WHERE ph.opening_id=o.id AND ${photoVisibleSql('ph', 2)}),'[]'::jsonb)
        ) ORDER BY o.opening_code,o.id)
        FROM openings o JOIN buildings b ON b.id=o.building_id WHERE b.property_id=p.id
      ), '[]'::jsonb) AS openings
      FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id
      WHERE p.id=$1 AND ${facilityAccessPredicate(2)}`, [req.params.id, req.auth!.organizationId]);
    if (!result.rows.length) return res.status(404).json({ error: "not_found" });
    res.set("Cache-Control", "no-store").json(result.rows[0]);
  } catch (error) {
    console.error("Facility dashboard read failed", error);
    res.status(503).json({ error: "facility_dashboard_unavailable" });
  }
});

// t97 item 2: only the facility owner's administrator may let assigned providers see each
// other's service history. Default is off (migration 20261029100000_provider_history_sharing).
portfolioRouter.put("/properties/:id/provider-history-sharing", async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_facility" });
  const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_setting" });
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "owner_admin_required" });
  try {
    const r = await pool.query(`UPDATE properties p SET share_provider_service_history=$3 FROM portfolios pf
      WHERE pf.id=p.portfolio_id AND p.id=$1 AND pf.organization_id=$2 RETURNING p.id, p.share_provider_service_history`,
      [req.params.id, req.auth!.organizationId, body.data.enabled]);
    if (!r.rows.length) return res.status(403).json({ error: "owner_admin_required" });
    res.set("Cache-Control", "no-store").json(r.rows[0]);
  } catch { res.status(503).json({ error: "setting_unavailable" }); }
});

// Search scope is always the current server-verified company. State, territory
// and phone location are convenience filters, never authorization inputs.
portfolioRouter.get("/facility-search", async (req: AuthedRequest, res) => {
  const parsed=z.object({state:z.string().regex(/^[A-Za-z]{2}$/).optional(),territory:z.string().max(120).optional(),q:z.string().max(200).optional()}).safeParse(req.query);
  if(!parsed.success)return res.status(400).json({error:"invalid_search"});
  try {
    let rows;
    try {
      rows=(await pool.query(`SELECT p.* FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id WHERE ${facilityAccessPredicate(1)} AND oi_private.caller_area_allows($2::uuid, p.id) ORDER BY p.name,p.id`,[req.auth!.organizationId, req.auth!.userId])).rows;
    } catch (error) {
      if (!isMissingSchema(error)) throw error;
      rows=(await pool.query(`SELECT p.* FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id WHERE ${facilityAccessPredicate(1)} ORDER BY p.name,p.id`,[req.auth!.organizationId])).rows;
    }
    const preferences=await pool.query('SELECT CASE WHEN b.id IS NOT NULL THEN b.default_state ELSE u.home_state END AS home_state, CASE WHEN b.id IS NOT NULL THEN b.default_territory ELSE u.home_territory END AS home_territory FROM users u LEFT JOIN user_branch_assignments a ON a.user_id=u.id AND a.organization_id=u.organization_id LEFT JOIN company_branches b ON b.id=a.branch_id AND b.organization_id=u.organization_id AND b.is_active=true WHERE u.id=$1 AND u.organization_id=$2',[req.auth!.userId,req.auth!.organizationId]);
    const {state,territory,q}=parsed.data;
    const term=(q||'').trim().toLowerCase();
    const facilities=rows.filter(p=>(!state||String(p.state||'').trim().toUpperCase()===state.toUpperCase())&&(!territory||p.service_territory===territory)&&(!term||[p.name,p.address_line1,p.city,p.state,p.postal_code].filter(Boolean).join(' ').toLowerCase().includes(term)));
    res.json({facilities,preferences:preferences.rows[0]||{},states:[...new Set(rows.map(p=>p.state?.trim().toUpperCase()).filter(Boolean))].sort(),territories:[...new Set(rows.map(p=>p.service_territory).filter(Boolean))].sort()});
  } catch {res.status(503).json({error:"facility_search_unavailable"});}
});

portfolioRouter.get("/portfolios", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;
  try {
    const result = await pool.query(
      `SELECT * FROM portfolios WHERE ${orgScope("organization_id", 1)} ORDER BY name`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

portfolioRouter.post("/portfolios", async (req: AuthedRequest, res) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const orgId = req.auth!.organizationId;
  try {
    const result = await pool.query(
      "INSERT INTO portfolios (organization_id, name) VALUES ($1, $2) RETURNING *",
      [orgId, parsed.data.name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const createPropertySchema = z.object({
  portfolio_id: z.string().uuid(),
  name: z.string().min(1),
  address_line1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  state_code: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  county_fips: z.string().regex(/^\d{5}$/).optional(),
  postal_code: z.string().optional(),
  property_type: z.enum(["multifamily", "senior_living", "healthcare", "university", "hospitality", "other"]).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  contact_email: z.string().trim().email().max(200).nullable().optional(),
});

portfolioRouter.post("/properties", async (req: AuthedRequest, res) => {
  const parsed = createPropertySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;

  try {
    const ownedPortfolio = await pool.query(
      "SELECT 1 FROM portfolios WHERE id = $1 AND organization_id = $2",
      [b.portfolio_id, orgId]
    );
    if (ownedPortfolio.rows.length === 0) return res.status(403).json({ error: "forbidden" });

    const result = await pool.query(
      `INSERT INTO properties
        (portfolio_id, name, address_line1, city, state, state_code, county_fips, postal_code, property_type, latitude, longitude, contact_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.portfolio_id, b.name, b.address_line1 ?? null, b.city ?? null, b.state ?? null,
       b.state_code ? b.state_code.toUpperCase() : null, b.county_fips ?? null,
       b.postal_code ?? null, b.property_type ?? null, b.latitude ?? null, b.longitude ?? null, b.contact_email ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

portfolioRouter.put("/properties/:id/contact-email", async (req: AuthedRequest, res) => {
  if (req.auth!.role !== "admin" && req.auth!.role !== "facilities_manager") return res.status(403).json({ error: "insufficient_role_for_action" });
  const body = z.object({ contact_email: z.string().trim().email().max(200).nullable() }).strict().safeParse(req.body);
  if (!body.success || !z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_email" });
  try {
    const result = await pool.query(
      `UPDATE properties p SET contact_email=$2
       FROM portfolios pf
       WHERE p.id=$1 AND p.portfolio_id=pf.id AND ${orgScope("pf.organization_id", 3)}
       RETURNING p.id, p.contact_email`,
      [req.params.id, body.data.contact_email, req.auth!.organizationId],
    );
    if (!result.rowCount) return res.status(404).json({ error: "not_found" });
    res.json(result.rows[0]);
  } catch { res.status(503).json({ error: "contact_email_save_failed" }); }
});

portfolioRouter.post("/buildings", async (req: AuthedRequest, res) => {
  const parsed = z.object({ property_id: z.string().uuid(), name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { property_id, name } = parsed.data;
  const orgId = req.auth!.organizationId;

  try {
    const ownedProperty = await pool.query(
      `SELECT 1 FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE p.id = $1 AND pf.organization_id = $2`,
      [property_id, orgId]
    );
    if (ownedProperty.rows.length === 0) return res.status(403).json({ error: "forbidden" });

    const result = await pool.query(
      "INSERT INTO buildings (property_id, name) VALUES ($1, $2) RETURNING *",
      [property_id, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Properties (with nested buildings) for the caller's organization —
// this is what powers the dashboard's property/building picker.
portfolioRouter.get("/properties", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;
  try {
    const propertiesSql = req.query.scope === "tree"
        ? `SELECT p.*, (pf.organization_id = $1) AS is_owner, (pf.organization_id <> $1 AND pf.organization_id = ANY($2::uuid[])) AS is_tree_location,
              s.name AS state_name, c.name AS county_name
           FROM properties p
       JOIN portfolios pf ON pf.id = p.portfolio_id
       LEFT JOIN us_states s ON s.code = p.state_code
       LEFT JOIN us_counties c ON c.fips = p.county_fips
       WHERE ${facilityAccessPredicateAny(2)} AND oi_private.caller_area_allows($3::uuid, p.id)
       ORDER BY s.name NULLS LAST, c.name NULLS LAST, p.name`
        : `SELECT p.*, (pf.organization_id = $1) AS is_owner, s.name AS state_name, c.name AS county_name FROM properties p
       JOIN portfolios pf ON pf.id = p.portfolio_id
       LEFT JOIN us_states s ON s.code = p.state_code
       LEFT JOIN us_counties c ON c.fips = p.county_fips
       WHERE ${facilityAccessPredicate(1)} AND oi_private.caller_area_allows($2::uuid, p.id)
       ORDER BY s.name NULLS LAST, c.name NULLS LAST, p.name`;
    const propertiesArgs = req.query.scope === "tree" ? [orgId, allowedOrgIds(req.auth!), req.auth!.userId] : [orgId, req.auth!.userId];
    let propertiesRes;
    try {
      propertiesRes = await pool.query(propertiesSql, propertiesArgs);
    } catch (error) {
      if (!isMissingSchema(error)) throw error;
      propertiesRes = await pool.query(
        req.query.scope === "tree"
          ? `SELECT p.*, (pf.organization_id = $1) AS is_owner, (pf.organization_id <> $1 AND pf.organization_id = ANY($2::uuid[])) AS is_tree_location FROM properties p
             JOIN portfolios pf ON pf.id = p.portfolio_id
             WHERE ${facilityAccessPredicateAny(2)}
             ORDER BY p.name`
          : `SELECT p.*, (pf.organization_id = $1) AS is_owner FROM properties p
             JOIN portfolios pf ON pf.id = p.portfolio_id
             WHERE ${facilityAccessPredicate(1)}
             ORDER BY p.name`,
        req.query.scope === "tree" ? [orgId, allowedOrgIds(req.auth!)] : [orgId]
      );
    }
    const properties = propertiesRes.rows;
    if (properties.length === 0) return res.json([]);

    const buildingsRes = await pool.query(
      `SELECT * FROM buildings WHERE property_id = ANY($1) ORDER BY name`,
      [properties.map((p) => p.id)]
    );
    const buildingsByProperty = new Map<string, any[]>();
    for (const b of buildingsRes.rows) {
      const list = buildingsByProperty.get(b.property_id) ?? [];
      list.push(b);
      buildingsByProperty.set(b.property_id, list);
    }

    res.json(properties.map((p) => ({ ...p, buildings: buildingsByProperty.get(p.id) ?? [] })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const FORECAST_BUCKETS = [
  { key: "urgent", label: "Urgent — replace within 1 year" },
  { key: "near_term", label: "Near-term — 2-3 years" },
  { key: "healthy", label: "Healthy — no near-term replacement needed" },
  { key: "unassessed", label: "Not yet assessed" },
] as const;

// Buckets openings by health score into a replacement timeline, broken down
// by opening_type within each bucket. Deliberately returns raw counts, not a
// dollar figure — per-opening replacement cost is a real assumption someone
// has to make (and it varies by market/vendor), so that assumption belongs
// in the dashboard where it can be adjusted and recalculated interactively,
// not baked into the API response as a guess presented as fact.
// Buckets openings by health score into a replacement timeline, broken down
// by opening_type within each bucket. Now blends two sources of cost data:
//
// 1. Real per-part costs, when a hardware_component has unit_cost set —
//    summed directly into `known_cost_total` for the bucket.
// 2. The dashboard's adjustable per-type estimate (e.g. "doors cost about
//    $800"), used only as a fallback for openings that have NO priced
//    hardware at all — counted separately in `needing_estimate_by_type` so
//    the frontend never double-counts an opening under both a real number
//    and a generic guess.
//
// Once an opening has ANY priced part, its whole `known_cost` (sum of
// however many parts are actually priced) is trusted over the generic
// estimate for that opening — a deliberate simplification rather than
// blending a partial real number with a partial generic guess on the same
// opening, which would be harder to reason about and easy to get wrong.
portfolioRouter.get("/capital-forecast", async (req: AuthedRequest, res) => {
  const { property_id } = req.query;
  const orgId = req.auth!.organizationId;

  if (!property_id || typeof property_id !== "string") {
    return res.status(400).json({ error: "property_id is required" });
  }

  try {
    const propertyResult = await pool.query(
      `SELECT p.name FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE p.id = $1 AND ${orgScope("pf.organization_id", 2)}`,
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
         FROM openings o
         JOIN buildings b ON b.id = o.building_id
         WHERE b.property_id = $1
       ),
       opening_known_cost AS (
         SELECT ob.id, ob.opening_type, ob.bucket,
           COALESCE(SUM(hc.unit_cost), 0) AS known_cost,
           COUNT(hc.id) FILTER (WHERE hc.unit_cost IS NOT NULL) AS priced_parts
         FROM opening_bucket ob
         LEFT JOIN current_hardware_components hc ON hc.opening_id = ob.id
         GROUP BY ob.id, ob.opening_type, ob.bucket
       )
       SELECT bucket, opening_type,
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE priced_parts = 0)::int AS count_needing_estimate,
         COALESCE(SUM(known_cost), 0) AS known_cost_total
       FROM opening_known_cost
       GROUP BY bucket, opening_type`,
      [property_id]
    );

    const buckets: Record<
      string,
      {
        label: string;
        total: number;
        by_type: Record<string, number>;
        needing_estimate_by_type: Record<string, number>;
        known_cost_total: number;
      }
    > = {};
    for (const b of FORECAST_BUCKETS) {
      buckets[b.key] = { label: b.label, total: 0, by_type: {}, needing_estimate_by_type: {}, known_cost_total: 0 };
    }
    let totalOpenings = 0;
    for (const row of result.rows) {
      buckets[row.bucket].by_type[row.opening_type] = row.total_count;
      if (row.count_needing_estimate > 0) {
        buckets[row.bucket].needing_estimate_by_type[row.opening_type] = row.count_needing_estimate;
      }
      buckets[row.bucket].known_cost_total += Number(row.known_cost_total);
      buckets[row.bucket].total += row.total_count;
      totalOpenings += row.total_count;
    }

    res.json({ property_name: propertyResult.rows[0].name, total_openings: totalOpenings, buckets });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Same bucketing logic as /capital-forecast, but across every property the
// org owns at once — a portfolio owner with 40 properties shouldn't have to
// click through 40 dashboards to find out where the risk actually is. This
// is a separate endpoint from /capital-forecast (not property_id-optional
// on the same route) so the existing single-property response shape never
// changes for whatever's already calling it.
portfolioRouter.get("/capital-forecast/rollup", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;

  try {
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
         WHERE ${orgScope("pf.organization_id", 1)}
       ),
       opening_known_cost AS (
         SELECT ob.id, ob.opening_type, ob.property_id, ob.property_name, ob.bucket,
           COALESCE(SUM(hc.unit_cost), 0) AS known_cost,
           COUNT(hc.id) FILTER (WHERE hc.unit_cost IS NOT NULL) AS priced_parts
         FROM opening_bucket ob
         LEFT JOIN current_hardware_components hc ON hc.opening_id = ob.id
         GROUP BY ob.id, ob.opening_type, ob.property_id, ob.property_name, ob.bucket
       )
       SELECT property_id, property_name, bucket, opening_type,
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE priced_parts = 0)::int AS count_needing_estimate,
         COALESCE(SUM(known_cost), 0) AS known_cost_total
       FROM opening_known_cost
       GROUP BY property_id, property_name, bucket, opening_type
       ORDER BY property_name`,
      [orgId]
    );

    const propertiesById: Record<
      string,
      {
        property_id: string;
        property_name: string;
        total_openings: number;
        buckets: Record<string, { label: string; total: number; by_type: Record<string, number>; needing_estimate_by_type: Record<string, number>; known_cost_total: number }>;
      }
    > = {};

    for (const row of result.rows) {
      if (!propertiesById[row.property_id]) {
        propertiesById[row.property_id] = {
          property_id: row.property_id,
          property_name: row.property_name,
          total_openings: 0,
          buckets: Object.fromEntries(FORECAST_BUCKETS.map((b) => [b.key, { label: b.label, total: 0, by_type: {}, needing_estimate_by_type: {}, known_cost_total: 0 }])),
        };
      }
      const property = propertiesById[row.property_id];
      property.buckets[row.bucket].by_type[row.opening_type] = row.total_count;
      if (row.count_needing_estimate > 0) {
        property.buckets[row.bucket].needing_estimate_by_type[row.opening_type] = row.count_needing_estimate;
      }
      property.buckets[row.bucket].known_cost_total += Number(row.known_cost_total);
      property.buckets[row.bucket].total += row.total_count;
      property.total_openings += row.total_count;
    }

    // Properties with zero openings never appear in the query above (nothing
    // to group on) — include them anyway so a brand-new property doesn't just
    // silently vanish from the rollup.
    const allProperties = await pool.query(
      `SELECT p.id, p.name FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id WHERE ${orgScope("pf.organization_id", 1)}`,
      [orgId]
    );
    for (const p of allProperties.rows) {
      if (!propertiesById[p.id]) {
        propertiesById[p.id] = {
          property_id: p.id,
          property_name: p.name,
          total_openings: 0,
          buckets: Object.fromEntries(FORECAST_BUCKETS.map((b) => [b.key, { label: b.label, total: 0, by_type: {}, needing_estimate_by_type: {}, known_cost_total: 0 }])),
        };
      }
    }

    res.json({ properties: Object.values(propertiesById).sort((a, b) => a.property_name.localeCompare(b.property_name)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// NFPA 80 requires annual fire door inspection — this surfaces which
// fire-rated/life-safety openings are overdue, due soon (within 30 days of
// the 1-year mark), or have never been inspected at all. This is
// deliberately the detection logic only: no email is sent from here — that
// would need a real email provider (SendGrid/SES/etc.) with credentials
// this project doesn't have. What this gives you is the same "who needs
// attention" answer an email would carry, live in the dashboard instead.
// property_id is optional — omit it to see alerts across the whole org.
portfolioRouter.get("/compliance-alerts", databaseRoute(async (req: AuthedRequest, res) => {
  const { property_id } = req.query;
  const orgId = req.auth!.organizationId;

  const conditions: string[] = ["(o.fire_rated = true OR o.life_safety_critical = true)"];
  const values: any[] = [];

  if (property_id && typeof property_id === "string") {
    const propertyResult = await pool.query(
      `SELECT p.name FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE p.id = $1 AND ${orgScope("pf.organization_id", 2)}`,
      [property_id, orgId]
    );
    if (propertyResult.rows.length === 0) return res.status(403).json({ error: "forbidden" });
    values.push(property_id);
    conditions.push(`b.property_id = $${values.length}`);
  } else {
    values.push(orgId);
    conditions.push(orgScope("pf.organization_id", values.length));
  }

  try {
    const result = await pool.query(
      `WITH opening_last_inspection AS (
         SELECT o.id, o.opening_code, o.floor_label, o.location_description,
                o.fire_rated, o.life_safety_critical,
                b.name AS building_name, p.name AS property_name, p.id AS property_id,
                li.event_date AS last_inspection_date
         FROM openings o
         JOIN buildings b ON b.id = o.building_id
         JOIN properties p ON p.id = b.property_id
         JOIN portfolios pf ON pf.id = p.portfolio_id
         LEFT JOIN LATERAL (
           SELECT event_date FROM inspection_events
           WHERE opening_id = o.id AND inspection_type = 'fire_door_nfpa80' AND checklist_result->>'status' = 'complete'
           ORDER BY event_date DESC LIMIT 1
         ) li ON true
         WHERE ${conditions.join(" AND ")}
       )
       SELECT *,
         CASE
           WHEN last_inspection_date IS NULL THEN 'never_inspected'
           WHEN last_inspection_date < CURRENT_DATE - INTERVAL '365 days' THEN 'overdue'
           WHEN last_inspection_date < CURRENT_DATE - INTERVAL '335 days' THEN 'due_soon'
           ELSE 'current'
         END AS alert_level
       FROM opening_last_inspection`,
      values
    );

    const severityOrder: Record<string, number> = { never_inspected: 0, overdue: 1, due_soon: 2, current: 3 };
    const alerts = result.rows
      .filter((r) => r.alert_level !== "current")
      .sort((a, b) => {
        const sevDiff = severityOrder[a.alert_level] - severityOrder[b.alert_level];
        if (sevDiff !== 0) return sevDiff;
        // Within the same severity, oldest inspection (or never-inspected) first
        if (!a.last_inspection_date) return -1;
        if (!b.last_inspection_date) return 1;
        return new Date(a.last_inspection_date).getTime() - new Date(b.last_inspection_date).getTime();
      });

    const counts = {
      never_inspected: alerts.filter((a) => a.alert_level === "never_inspected").length,
      overdue: alerts.filter((a) => a.alert_level === "overdue").length,
      due_soon: alerts.filter((a) => a.alert_level === "due_soon").length,
    };

    res.json({ total_flagged: alerts.length, counts, alerts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
}));

// warranty_expiration has been captured on every hardware part since the
// cost/supplier work (see README §23), but nothing ever surfaced it — it
// was only visible by opening a raw CSV export and scrolling to that
// column. This flags parts already past warranty, or expiring within 90
// days, the same "detect it, don't make someone go looking" pattern as
// compliance-alerts. Unlike inspections, a missing warranty_expiration
// isn't itself alert-worthy (plenty of hardware is never warrantied, or the
// warranty just wasn't logged) — only rows with a real date get evaluated.
portfolioRouter.get("/warranty-alerts", databaseRoute(async (req: AuthedRequest, res) => {
  const { property_id } = req.query;
  const orgId = req.auth!.organizationId;

  const conditions: string[] = ["hc.warranty_expiration IS NOT NULL"];
  const values: any[] = [];

  if (property_id && typeof property_id === "string") {
    const propertyResult = await pool.query(
      `SELECT p.name FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE p.id = $1 AND ${orgScope("pf.organization_id", 2)}`,
      [property_id, orgId]
    );
    if (propertyResult.rows.length === 0) return res.status(403).json({ error: "forbidden" });
    values.push(property_id);
    conditions.push(`p.id = $${values.length}`);
  } else {
    values.push(orgId);
    conditions.push(orgScope("pf.organization_id", values.length));
  }

  try {
    const result = await pool.query(
      `SELECT hc.id AS hardware_id, hc.component_type, hc.manufacturer, hc.model_number,
              hc.tracker_id, hc.warranty_expiration,
              o.id AS opening_id, o.opening_code,
              b.name AS building_name, p.name AS property_name, p.id AS property_id,
              CASE
                WHEN hc.warranty_expiration < CURRENT_DATE THEN 'expired'
                WHEN hc.warranty_expiration < CURRENT_DATE + INTERVAL '90 days' THEN 'expiring_soon'
                ELSE 'not_yet'
              END AS alert_level
       FROM current_hardware_components hc
       JOIN openings o ON o.id = hc.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE ${conditions.join(" AND ")}`,
      values
    );

    const severityOrder: Record<string, number> = { expired: 0, expiring_soon: 1, not_yet: 2 };
    const alerts = result.rows
      .filter((r) => r.alert_level !== "not_yet")
      .sort((a, b) => {
        const sevDiff = severityOrder[a.alert_level] - severityOrder[b.alert_level];
        if (sevDiff !== 0) return sevDiff;
        return new Date(a.warranty_expiration).getTime() - new Date(b.warranty_expiration).getTime();
      });

    const counts = {
      expired: alerts.filter((a) => a.alert_level === "expired").length,
      expiring_soon: alerts.filter((a) => a.alert_level === "expiring_soon").length,
    };

    res.json({ total_flagged: alerts.length, counts, alerts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
}));
