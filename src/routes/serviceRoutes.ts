import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { facilityAccessPredicate } from "../db/tenantScope";
import { requireAuth, AuthedRequest, isMissingSchema } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { mayOpenCompanyDashboard, COMPANY_DASHBOARD_REFUSAL } from "../services/companyDashboard";
import { planDrive, mapsLink, prefersAppleMaps, haversineMiles, type StopPoint } from "../services/driveTime";

const NEARBY_MILES = 15;
const workKind = z.enum(["work_order", "inspection", "advised_repair"]);

function office(req: AuthedRequest, res: { status: (code: number) => { json: (body: unknown) => void } }): boolean {
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

function addressOf(row: { address_line1?: string | null; city?: string | null; state?: string | null; name?: string | null }): string {
  const line = [row.address_line1, row.city, row.state].filter((part) => part && String(part).trim()).join(", ");
  return line || row.name || "Address not recorded";
}

async function assignees(orgId: string) {
  try {
    const rows = await pool.query(
      `SELECT u.id, u.full_name, m.role
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND m.is_active AND u.is_active
         AND m.role IN ('admin', 'facilities_manager', 'technician')
       ORDER BY u.full_name`,
      [orgId],
    );
    if (rows.rows.length) return rows.rows;
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
  }
  const legacy = await pool.query(
    `SELECT id, full_name, role FROM users
     WHERE organization_id = $1 AND is_active AND role IN ('admin', 'facilities_manager', 'technician')
     ORDER BY full_name`,
    [orgId],
  );
  return legacy.rows;
}

async function candidates(orgId: string, serviceDate: string) {
  const work = await pool.query(
    `SELECT wo.id AS work_id, 'work_order' AS work_kind, wo.title AS summary, o.opening_code,
            p.id AS property_id, p.name AS property_name, p.address_line1, p.city, p.state, p.latitude, p.longitude,
            wo.due_date
     FROM work_orders wo
     JOIN openings o ON o.id = wo.opening_id
     JOIN buildings b ON b.id = o.building_id
     JOIN properties p ON p.id = b.property_id
     JOIN portfolios pf ON pf.id = p.portfolio_id
     WHERE wo.status IN ('open', 'in_progress') AND ${facilityAccessPredicate(1)}
     ORDER BY wo.due_date NULLS LAST, p.name
     LIMIT 200`,
    [orgId],
  );
  let inspections: any[] = [];
  try {
    const due = await pool.query(
      `SELECT ms.id AS work_id, 'inspection' AS work_kind, ms.title AS summary, o.opening_code,
              p.id AS property_id, p.name AS property_name, p.address_line1, p.city, p.state, p.latitude, p.longitude,
              ms.next_due_date AS due_date
       FROM maintenance_schedules ms
       JOIN openings o ON o.id = ms.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE ms.is_active AND ms.next_due_date <= $2::date AND ${facilityAccessPredicate(1)}
       ORDER BY ms.next_due_date, p.name
       LIMIT 200`,
      [orgId, serviceDate],
    );
    inspections = due.rows;
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
  }
  return [...work.rows, ...inspections].map((row) => ({
    ...row,
    due_date: day(row.due_date),
    address: addressOf(row),
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
  }));
}

async function propertyForWork(orgId: string, workKind: string, workId: string) {
  if (workKind === "work_order") {
    const row = await pool.query(
      `SELECT p.id, p.name, p.address_line1, p.city, p.state, p.latitude, p.longitude, wo.title AS summary, o.opening_code
       FROM work_orders wo
       JOIN openings o ON o.id = wo.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE wo.id = $1 AND wo.status IN ('open', 'in_progress') AND ${facilityAccessPredicate(2)}`,
      [workId, orgId],
    );
    return row.rows[0] ?? null;
  }
  if (workKind === "inspection") {
    const row = await pool.query(
      `SELECT p.id, p.name, p.address_line1, p.city, p.state, p.latitude, p.longitude, ms.title AS summary, o.opening_code
       FROM maintenance_schedules ms
       JOIN openings o ON o.id = ms.opening_id
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       JOIN portfolios pf ON pf.id = p.portfolio_id
       WHERE ms.id = $1 AND ms.is_active AND ${facilityAccessPredicate(2)}`,
      [workId, orgId],
    );
    return row.rows[0] ?? null;
  }
  return null;
}

function pointsFrom(rows: Array<{ work_id: string; latitude: unknown; longitude: unknown }>): StopPoint[] {
  return rows.map((row) => ({
    id: row.work_id,
    latitude: row.latitude === null || row.latitude === undefined || row.latitude === "" ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined || row.longitude === "" ? null : Number(row.longitude),
  }));
}

async function loadRoute(orgId: string, routeId: string) {
  const route = await pool.query(
    `SELECT r.*, u.full_name AS assignee_name
     FROM service_routes r
     LEFT JOIN users u ON u.id = r.assigned_user_id
     WHERE r.id = $1 AND r.provider_organization_id = $2`,
    [routeId, orgId],
  );
  if (!route.rows[0]) return null;
  const stops = await pool.query(
    `SELECT s.*, p.name AS property_name, p.address_line1, p.city, p.state, p.latitude, p.longitude,
            COALESCE(wo.title, ms.title, 'Work') AS summary,
            COALESCE(wo_opening.opening_code, ms_opening.opening_code) AS opening_code,
            wo.status AS work_order_status
     FROM service_route_stops s
     JOIN properties p ON p.id = s.property_id
     LEFT JOIN work_orders wo ON s.work_kind = 'work_order' AND wo.id = s.work_id
     LEFT JOIN openings wo_opening ON wo_opening.id = wo.opening_id
     LEFT JOIN maintenance_schedules ms ON s.work_kind = 'inspection' AND ms.id = s.work_id
     LEFT JOIN openings ms_opening ON ms_opening.id = ms.opening_id
     WHERE s.route_id = $1
     ORDER BY s.position, s.id`,
    [routeId],
  );
  const shaped = stops.rows.map((row) => ({
    ...row,
    address: addressOf(row),
    done: row.work_kind === "work_order" && row.work_order_status === "done",
    maps: {
      apple: mapsLink(addressOf(row), true),
      google: mapsLink(addressOf(row), false),
    },
  }));
  const active = shaped.filter((row) => row.status !== "declined");
  const total = active.reduce((sum, row) => sum + (row.drive_minutes ?? 0), 0);
  return { ...route.rows[0], service_date: day(route.rows[0].service_date), stops: shaped, total_minutes: total };
}

export const companyServiceRoutesRouter = Router();
companyServiceRoutesRouter.use(requireAuth, auditLog);

companyServiceRoutesRouter.get("/assignees", async (req: AuthedRequest, res) => {
  if (office(req, res)) return;
  try {
    res.set("Cache-Control", "no-store").json({ people: await assignees(req.auth!.organizationId) });
  } catch (error) {
    console.error("Route assignees failed", error);
    res.status(503).json({ error: "route_unavailable" });
  }
});

companyServiceRoutesRouter.get("/candidates", async (req: AuthedRequest, res) => {
  if (office(req, res)) return;
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(req.query.date);
  if (!date.success) return res.status(400).json({ error: "invalid_date" });
  try {
    res.set("Cache-Control", "no-store").json({ candidates: await candidates(req.auth!.organizationId, date.data) });
  } catch (error) {
    console.error("Route candidates failed", error);
    res.status(503).json({ error: "route_unavailable" });
  }
});

companyServiceRoutesRouter.get("/", async (req: AuthedRequest, res) => {
  if (office(req, res)) return;
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(req.query.date);
  if (!date.success) return res.status(400).json({ error: "invalid_date" });
  try {
    const found = await pool.query(
      `SELECT id FROM service_routes
       WHERE provider_organization_id = $1 AND service_date = $2::date
       ORDER BY created_at DESC`,
      [req.auth!.organizationId, date.data],
    );
    const routes = [];
    for (const row of found.rows) routes.push(await loadRoute(req.auth!.organizationId, row.id));
    const drive_label = process.env.GOOGLE_MAPS_API_KEY
      ? "Drive times saved with this route."
      : "Straight-line estimate from the map location, not a road route. About 30 miles an hour.";
    res.set("Cache-Control", "no-store").json({ routes, drive_label });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ error: "route_unavailable" });
    console.error("Route read failed", error);
    res.status(503).json({ error: "route_unavailable" });
  }
});

const buildSchema = z.object({
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assigned_user_id: z.string().uuid(),
  stops: z.array(z.object({
    work_kind: workKind,
    work_id: z.string().uuid(),
    time_window: z.string().trim().max(80).optional(),
  })).min(1).max(25),
}).strict();

companyServiceRoutesRouter.post("/", async (req: AuthedRequest, res) => {
  if (office(req, res)) return;
  const parsed = buildSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_route" });
  const orgId = req.auth!.organizationId;
  try {
    const people = await assignees(orgId);
    if (!people.some((person) => person.id === parsed.data.assigned_user_id)) {
      return res.status(400).json({ error: "invalid_assignee" });
    }
    const chosen = [];
    for (const stop of parsed.data.stops) {
      const property = await propertyForWork(orgId, stop.work_kind, stop.work_id);
      if (!property) return res.status(400).json({ error: "invalid_stop" });
      chosen.push({ ...stop, ...property, property_id: property.id });
    }
    const plan = await planDrive(pointsFrom(chosen), process.env.GOOGLE_MAPS_API_KEY);
    const byWork = new Map(chosen.map((stop) => [stop.work_id, stop]));
    const minutesByStop = new Map<string, number | null>();
    for (const leg of plan.legs) minutesByStop.set(leg.to_id, leg.minutes);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT id FROM service_routes
         WHERE provider_organization_id = $1 AND service_date = $2::date AND assigned_user_id = $3
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [orgId, parsed.data.service_date, parsed.data.assigned_user_id],
      );
      let routeId = existing.rows[0]?.id as string | undefined;
      if (!routeId) {
        routeId = (await client.query(
          `INSERT INTO service_routes (id, provider_organization_id, service_date, assigned_user_id, created_by_user_id)
           VALUES (gen_random_uuid(), $1, $2::date, $3, $4) RETURNING id`,
          [orgId, parsed.data.service_date, parsed.data.assigned_user_id, req.auth!.userId],
        )).rows[0].id;
      }
      await client.query("UPDATE service_route_stops SET position = position + 10000 WHERE route_id = $1", [routeId]);
      await client.query(
        `UPDATE service_route_stops SET status = 'declined'
         WHERE route_id = $1 AND status = 'approved' AND requested_by_user_id IS NULL`,
        [routeId],
      );
      let position = 1;
      for (const workId of plan.order) {
        const stop = byWork.get(workId);
        if (!stop) continue;
        await client.query(
          `INSERT INTO service_route_stops
             (id, route_id, position, status, work_kind, work_id, property_id, time_window, drive_minutes)
           VALUES (gen_random_uuid(), $1, $2, 'approved', $3, $4, $5, $6, $7)`,
          [routeId, position, stop.work_kind, stop.work_id, stop.property_id, stop.time_window || null, minutesByStop.get(workId) ?? null],
        );
        position += 1;
      }
      const requested = await client.query(
        `SELECT id FROM service_route_stops WHERE route_id = $1 AND status = 'requested' ORDER BY id`,
        [routeId],
      );
      for (const row of requested.rows) {
        await client.query("UPDATE service_route_stops SET position = $2 WHERE id = $1", [row.id, position]);
        position += 1;
      }
      await client.query("COMMIT");
      if (!routeId) throw new Error("route_missing");
      const route = await loadRoute(orgId, routeId);
      res.status(201).json({ route, drive_source: plan.source, drive_label: plan.label, total_minutes: plan.total_minutes });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") return res.status(409).json({ error: "work_already_claimed" });
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ error: "route_unavailable" });
    console.error("Route build failed", error);
    res.status(500).json({ error: "route_build_failed" });
  }
});

companyServiceRoutesRouter.post("/stops/:id/decision", async (req: AuthedRequest, res) => {
  if (office(req, res)) return;
  const parsed = z.object({ decision: z.enum(["approve", "decline"]) }).strict().safeParse(req.body);
  if (!z.string().uuid().safeParse(req.params.id).success || !parsed.success) return res.status(400).json({ error: "invalid_decision" });
  try {
    const status = parsed.data.decision === "approve" ? "approved" : "declined";
    const updated = await pool.query(
      `UPDATE service_route_stops s SET status = $3
       FROM service_routes r
       WHERE s.id = $1 AND s.route_id = r.id AND r.provider_organization_id = $2 AND s.status = 'requested'
       RETURNING s.route_id`,
      [req.params.id, req.auth!.organizationId, status],
    );
    if (!updated.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ route: await loadRoute(req.auth!.organizationId, updated.rows[0].route_id) });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return res.status(409).json({ error: "work_already_claimed" });
    console.error("Route decision failed", error);
    res.status(500).json({ error: "route_decision_failed" });
  }
});

export const fieldServiceRoutesRouter = Router();
fieldServiceRoutesRouter.use(requireAuth, auditLog);

fieldServiceRoutesRouter.get("/today", async (req: AuthedRequest, res) => {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(String(req.query.date || new Date().toISOString().slice(0, 10)));
  if (!date.success) return res.status(400).json({ error: "invalid_date" });
  try {
    const found = await pool.query(
      `SELECT id FROM service_routes
       WHERE provider_organization_id = $1 AND assigned_user_id = $2 AND service_date = $3::date
       ORDER BY created_at DESC LIMIT 1`,
      [req.auth!.organizationId, req.auth!.userId, date.data],
    );
    if (!found.rows[0]) return res.json({ route: null, apple_maps: prefersAppleMaps(String(req.get("user-agent") || "")) });
    const route = await loadRoute(req.auth!.organizationId, found.rows[0].id);
    res.set("Cache-Control", "no-store").json({
      route: route ? { ...route, stops: route.stops.filter((stop: { status: string }) => stop.status === "approved") } : null,
      apple_maps: prefersAppleMaps(String(req.get("user-agent") || "")),
    });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ error: "route_unavailable" });
    console.error("Field route read failed", error);
    res.status(503).json({ error: "route_unavailable" });
  }
});

fieldServiceRoutesRouter.post("/stops/:id/done", async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "invalid_stop" });
  try {
    const stop = await pool.query(
      `SELECT s.*, r.assigned_user_id, r.provider_organization_id
       FROM service_route_stops s
       JOIN service_routes r ON r.id = s.route_id
       WHERE s.id = $1 AND r.provider_organization_id = $2 AND r.assigned_user_id = $3 AND s.status = 'approved'`,
      [req.params.id, req.auth!.organizationId, req.auth!.userId],
    );
    const row = stop.rows[0];
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.work_kind === "work_order") {
      await pool.query("UPDATE work_orders SET status = 'done', completed_at = now() WHERE id = $1 AND status IN ('open', 'in_progress')", [row.work_id]);
    } else if (row.work_kind === "inspection") {
      await pool.query(
        `UPDATE maintenance_schedules SET next_due_date = (
           next_due_date + CASE interval_unit
             WHEN 'days' THEN make_interval(days => interval_count)
             WHEN 'weeks' THEN make_interval(weeks => interval_count)
             WHEN 'months' THEN make_interval(months => interval_count)
             WHEN 'years' THEN make_interval(years => interval_count)
             ELSE make_interval(years => 1)
           END
         )::date
         WHERE id = $1`,
        [row.work_id],
      );
    }
    res.json({ done: true });
  } catch (error) {
    console.error("Mark stop done failed", error);
    res.status(500).json({ error: "stop_done_failed" });
  }
});

fieldServiceRoutesRouter.get("/nearby", async (req: AuthedRequest, res) => {
  try {
    const route = await pool.query(
      `SELECT r.id, s.property_id, p.latitude, p.longitude
       FROM service_routes r
       JOIN service_route_stops s ON s.route_id = r.id AND s.status = 'approved'
       JOIN properties p ON p.id = s.property_id
       WHERE r.provider_organization_id = $1 AND r.assigned_user_id = $2 AND r.service_date = CURRENT_DATE
         AND NOT (s.work_kind = 'work_order' AND EXISTS (SELECT 1 FROM work_orders wo WHERE wo.id = s.work_id AND wo.status = 'done'))
       ORDER BY r.created_at DESC, s.position
       LIMIT 1`,
      [req.auth!.organizationId, req.auth!.userId],
    );
    const origin = route.rows[0];
    if (!origin || origin.latitude === null || origin.longitude === null) return res.json({ nearby: [], radius_miles: NEARBY_MILES });
    const rows = await pool.query(
      `SELECT e.work_kind, e.work_id, p.id AS property_id, p.name AS property_name, p.address_line1, p.city, p.state,
              p.latitude, p.longitude, COALESCE(wo.title, ms.title, 'Work') AS summary,
              COALESCE(pa.notice_required, false) AS notice_required, pa.kind AS account_kind
       FROM work_pickup_eligibility e
       LEFT JOIN work_orders wo ON e.work_kind = 'work_order' AND wo.id = e.work_id AND wo.status IN ('open', 'in_progress')
       LEFT JOIN maintenance_schedules ms ON e.work_kind = 'inspection' AND ms.id = e.work_id AND ms.is_active
       JOIN openings o ON o.id = COALESCE(wo.opening_id, ms.opening_id)
       JOIN buildings b ON b.id = o.building_id
       JOIN properties p ON p.id = b.property_id
       LEFT JOIN provider_account_sites pas ON pas.property_id = p.id
       LEFT JOIN provider_accounts pa ON pa.id = pas.account_id AND pa.provider_organization_id = e.provider_organization_id
       WHERE e.provider_organization_id = $1 AND e.eligible = true
         AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM service_route_stops claimed
           WHERE claimed.work_kind = e.work_kind AND claimed.work_id = e.work_id
             AND claimed.status IN ('requested', 'approved')
         )`,
      [req.auth!.organizationId],
    );
    const nearby = rows.rows.map((row) => {
      const miles = haversineMiles(
        { latitude: Number(origin.latitude), longitude: Number(origin.longitude) },
        { latitude: Number(row.latitude), longitude: Number(row.longitude) },
      );
      const scheduleOnly = row.notice_required === true && row.account_kind === "facility";
      return {
        work_kind: row.work_kind,
        work_id: row.work_id,
        property_id: row.property_id,
        property_name: row.property_name,
        address: addressOf(row),
        summary: row.summary,
        miles: Math.round(miles * 10) / 10,
        schedule_only: scheduleOnly,
      };
    }).filter((row) => row.miles <= NEARBY_MILES).sort((a, b) => a.miles - b.miles);
    res.set("Cache-Control", "no-store").json({ nearby, radius_miles: NEARBY_MILES });
  } catch (error) {
    if (isMissingSchema(error)) return res.status(503).json({ error: "route_unavailable" });
    console.error("Nearby work failed", error);
    res.status(503).json({ error: "route_unavailable" });
  }
});

fieldServiceRoutesRouter.post("/nearby", async (req: AuthedRequest, res) => {
  const parsed = z.object({ work_kind: workKind, work_id: z.string().uuid() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_pickup" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const route = await client.query(
      `SELECT id FROM service_routes
       WHERE provider_organization_id = $1 AND assigned_user_id = $2 AND service_date = CURRENT_DATE
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [req.auth!.organizationId, req.auth!.userId],
    );
    if (!route.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "no_route_today" });
    }
    const property = await propertyForWork(req.auth!.organizationId, parsed.data.work_kind, parsed.data.work_id);
    if (!property) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_eligible" });
    }
    const eligible = await client.query(
      `SELECT 1 FROM work_pickup_eligibility
       WHERE provider_organization_id = $1 AND work_kind = $2 AND work_id = $3 AND eligible = true`,
      [req.auth!.organizationId, parsed.data.work_kind, parsed.data.work_id],
    );
    if (!eligible.rows.length) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "not_eligible" });
    }
    const origin = await client.query(
      `SELECT p.latitude, p.longitude
       FROM service_route_stops s
       JOIN properties p ON p.id = s.property_id
       WHERE s.route_id = $1 AND s.status = 'approved' AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         AND NOT (s.work_kind = 'work_order' AND EXISTS (SELECT 1 FROM work_orders wo WHERE wo.id = s.work_id AND wo.status = 'done'))
       ORDER BY s.position LIMIT 1`,
      [route.rows[0].id],
    );
    if (!origin.rows[0] || property.latitude === null || property.longitude === null) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "not_nearby" });
    }
    const miles = haversineMiles(
      { latitude: Number(origin.rows[0].latitude), longitude: Number(origin.rows[0].longitude) },
      { latitude: Number(property.latitude), longitude: Number(property.longitude) },
    );
    if (miles > NEARBY_MILES) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "not_nearby" });
    }
    const notice = await client.query(
      `SELECT pa.notice_required, pa.kind
       FROM provider_account_sites pas
       JOIN provider_accounts pa ON pa.id = pas.account_id
       WHERE pas.property_id = $1 AND pa.provider_organization_id = $2
       LIMIT 1`,
      [property.id, req.auth!.organizationId],
    );
    if (notice.rows[0]?.notice_required === true && notice.rows[0]?.kind === "facility") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "schedule_only", message: "This facility needs notice. It can be scheduled, not picked up." });
    }
    const position = await client.query("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM service_route_stops WHERE route_id = $1", [route.rows[0].id]);
    await client.query(
      `INSERT INTO service_route_stops
         (id, route_id, position, status, work_kind, work_id, property_id, requested_by_user_id)
       VALUES (gen_random_uuid(), $1, $2, 'requested', $3, $4, $5, $6)`,
      [route.rows[0].id, position.rows[0].next, parsed.data.work_kind, parsed.data.work_id, property.id, req.auth!.userId],
    );
    await client.query("COMMIT");
    res.status(201).json({ status: "requested" });
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") return res.status(409).json({ error: "work_already_claimed", message: "Another person already requested this work." });
    console.error("Nearby pickup failed", error);
    res.status(500).json({ error: "pickup_failed" });
  } finally {
    client.release();
  }
});
