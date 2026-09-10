import { Router, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import { z } from "zod";
import { pool } from "../db/pool";
import { computeHealthScore } from "../services/healthScore";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { buildingsForOrgSubquery, openingsForOrgSubquery } from "../db/tenantScope";

export const openingsRouter = Router();
openingsRouter.use(requireAuth);
openingsRouter.use(enforceRolePermissions);
openingsRouter.use(auditLog);

function forbidden(res: Response) {
  return res.status(403).json({ error: "forbidden" });
}

// Load an opening together with its hardware, service/inspection history, and
// photos so every single-opening endpoint returns the same shape the field-app
// and dashboard detail views expect. by-qr and by-code (the field app's scan
// and manual-entry entry points) previously returned only the bare opening row,
// so a scanned/looked-up opening showed no photos, hardware, or history at all.
async function hydrateOpening(openingRow: any) {
  const openingId = openingRow.id;
  const [hardware, serviceEvents, inspections, photos] = await Promise.all([
    pool.query("SELECT * FROM hardware_components WHERE opening_id = $1 ORDER BY install_date", [openingId]),
    pool.query("SELECT * FROM service_events WHERE opening_id = $1 ORDER BY event_date DESC", [openingId]),
    pool.query("SELECT * FROM inspection_events WHERE opening_id = $1 ORDER BY event_date DESC", [openingId]),
    pool.query("SELECT * FROM photos WHERE opening_id = $1 ORDER BY created_at DESC", [openingId]),
  ]);
  return {
    ...openingRow,
    hardware_components: hardware.rows,
    service_events: serviceEvents.rows,
    inspection_events: inspections.rows,
    photos: photos.rows,
  };
}

const createOpeningSchema = z.object({
  opening_code: z.string().min(1),
  building_id: z.string().uuid(),
  floor_label: z.string().optional(),
  location_description: z.string().optional(),
  opening_type: z.enum([
    "door", "overhead_door", "loading_dock", "gate", "automatic_entrance", "access_control_point",
  ]),
  fire_rated: z.boolean().optional(),
  life_safety_critical: z.boolean().optional(),
  is_electrified: z.boolean().optional(),
  install_date: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

// Create a new opening + generate its QR token/code.
// building_id must belong to the caller's organization.
openingsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createOpeningSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const body = parsed.data;
  const qrToken = uuidv4();
  const orgId = req.auth!.organizationId;

  try {
    const ownedBuilding = await pool.query(
      `SELECT 1 FROM (${buildingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
      [body.building_id, orgId]
    );
    if (ownedBuilding.rows.length === 0) return forbidden(res);

    const result = await pool.query(
      `INSERT INTO openings
        (opening_code, building_id, floor_label, location_description, opening_type,
         fire_rated, life_safety_critical, is_electrified, install_date, latitude, longitude, qr_token, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_capture')
       RETURNING *`,
      [
        body.opening_code, body.building_id, body.floor_label ?? null,
        body.location_description ?? null, body.opening_type,
        body.fire_rated ?? false, body.life_safety_critical ?? false, body.is_electrified ?? false,
        body.install_date ?? null, body.latitude ?? null, body.longitude ?? null,
        qrToken,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "opening_code already exists" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const bulkImportRowSchema = z.object({
  opening_code: z.string().min(1),
  opening_type: z.enum([
    "door", "overhead_door", "loading_dock", "gate", "automatic_entrance", "access_control_point",
  ]),
  floor_label: z.string().optional(),
  location_description: z.string().optional(),
  fire_rated: z.boolean().optional(),
  life_safety_critical: z.boolean().optional(),
  is_electrified: z.boolean().optional(),
  install_date: z.string().optional(),
});

const bulkImportSchema = z.object({
  building_id: z.string().uuid(),
  rows: z.array(bulkImportRowSchema).min(1).max(1000),
});

// Bulk-create openings under one building from a CSV import. Each row is
// validated and inserted independently — a handful of bad rows (a typo'd
// opening_type, a duplicate code someone already used) shouldn't sink an
// otherwise-good 300-row import. The response reports success/failure per
// row so the dashboard can show exactly what happened, not just "it worked"
// or "it didn't."
openingsRouter.post("/bulk-import", async (req: AuthedRequest, res) => {
  const parsed = bulkImportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { building_id, rows } = parsed.data;
  const orgId = req.auth!.organizationId;

  const ownedBuilding = await pool.query(
    `SELECT 1 FROM (${buildingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [building_id, orgId]
  );
  if (ownedBuilding.rows.length === 0) return forbidden(res);

  const results: Array<{
    row: number;
    opening_code: string;
    status: "created" | "error";
    id?: string;
    error?: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const qrToken = uuidv4();
      const result = await pool.query(
        `INSERT INTO openings
          (opening_code, building_id, floor_label, location_description, opening_type,
           fire_rated, life_safety_critical, is_electrified, install_date, qr_token, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_capture')
         RETURNING id`,
        [
          row.opening_code, building_id, row.floor_label ?? null,
          row.location_description ?? null, row.opening_type,
          row.fire_rated ?? false, row.life_safety_critical ?? false, row.is_electrified ?? false,
          row.install_date ?? null, qrToken,
        ]
      );
      results.push({ row: i, opening_code: row.opening_code, status: "created", id: result.rows[0].id });
    } catch (err: any) {
      const message = err.code === "23505" ? "opening_code already exists" : "insert_failed";
      results.push({ row: i, opening_code: row.opening_code, status: "error", error: message });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  res.status(207).json({ // 207 Multi-Status — partial success is the expected common case here
    total: rows.length,
    created,
    failed: rows.length - created,
    results,
  });
});

// Batch QR generation for an entire building — pairs with bulk import:
// import 200 openings from a CSV, then get all 200 QR codes in one request
// instead of 200 round trips, ready to lay out on a print-friendly label
// sheet. Registered ABOVE /:id on purpose: Express matches routes in
// registration order, and /:id is a single-segment wildcard that would
// otherwise swallow /qr-codes (treating "qr-codes" as the id value) before
// this handler is ever reached — caught by testing the route directly
// rather than trusting registration order would sort itself out.
openingsRouter.get("/qr-codes", async (req: AuthedRequest, res) => {
  const { building_id } = req.query;
  const orgId = req.auth!.organizationId;

  if (!building_id || typeof building_id !== "string") {
    return res.status(400).json({ error: "building_id is required" });
  }

  const ownedBuilding = await pool.query(
    `SELECT 1 FROM (${buildingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [building_id, orgId]
  );
  if (ownedBuilding.rows.length === 0) return forbidden(res);

  try {
    const openings = await pool.query(
      `SELECT id, opening_code, qr_token, opening_type, floor_label, location_description
       FROM openings WHERE building_id = $1 ORDER BY opening_code`,
      [building_id]
    );

    const items = await Promise.all(
      openings.rows.map(async (o) => {
        const payload = `https://app.openingintel.com/scan/${o.qr_token}`;
        const qr_data_url = await QRCode.toDataURL(payload, { width: 300, margin: 1 });
        return {
          id: o.id,
          opening_code: o.opening_code,
          opening_type: o.opening_type,
          floor_label: o.floor_label,
          location_description: o.location_description,
          qr_data_url,
        };
      })
    );

    res.json({ building_id, count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Get a single opening with its hardware, service history, and inspection history —
// only if it belongs to the caller's organization.
openingsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const opening = await pool.query(
      `SELECT * FROM openings WHERE id = $1 AND id IN (${openingsForOrgSubquery(2)})`,
      [id, orgId]
    );
    if (opening.rows.length === 0) return res.status(404).json({ error: "not_found" });

    res.json(await hydrateOpening(opening.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Resolve a scanned QR token to its opening — this is the field-app entry point.
// Scoped to the caller's org so a tech can't resolve another customer's QR code.
openingsRouter.get("/by-qr/:qrToken", async (req: AuthedRequest, res) => {
  const { qrToken } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const result = await pool.query(
      `SELECT * FROM openings WHERE qr_token = $1 AND id IN (${openingsForOrgSubquery(2)})`,
      [qrToken, orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json(await hydrateOpening(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Resolve a manually-typed opening_code (the human-readable code printed on
// the door tag, e.g. AZ-PHX-BLDG03-F02-0214) — this is distinct from by-qr
// on purpose: a technician typing the code they can actually read off the
// tag doesn't know the internal qr_token UUID embedded in the QR itself.
openingsRouter.get("/by-code/:openingCode", async (req: AuthedRequest, res) => {
  const { openingCode } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const result = await pool.query(
      `SELECT * FROM openings WHERE opening_code = $1 AND id IN (${openingsForOrgSubquery(2)})`,
      [openingCode, orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json(await hydrateOpening(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Generate a printable QR code image (PNG data URL) for a given opening
openingsRouter.get("/:id/qr-code", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const result = await pool.query(
      `SELECT qr_token FROM openings WHERE id = $1 AND id IN (${openingsForOrgSubquery(2)})`,
      [id, orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const { qr_token } = result.rows[0];
    const payload = `https://app.openingintel.com/scan/${qr_token}`;
    const dataUrl = await QRCode.toDataURL(payload, { width: 400, margin: 2 });
    res.json({ qr_data_url: dataUrl, payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Batch QR generation for an entire building — pairs with bulk import: import
// 200 openings from a CSV, then get all 200 QR codes in one request instead
// of 200 round trips, ready to lay out on a print-friendly label sheet.

// Recompute and persist the health score for an opening
openingsRouter.post("/:id/recompute-health-score", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const openingRes = await pool.query(
      `SELECT install_date, last_service_date, fire_rated FROM openings
       WHERE id = $1 AND id IN (${openingsForOrgSubquery(2)})`,
      [id, orgId]
    );
    if (openingRes.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const opening = openingRes.rows[0];

    const serviceCountRes = await pool.query(
      `SELECT COUNT(*) FROM service_events
       WHERE opening_id = $1 AND event_date >= now() - interval '12 months'`,
      [id]
    );
    const failedInspectionsRes = await pool.query(
      `SELECT COUNT(*) FROM inspection_events
       WHERE opening_id = $1 AND passed = false AND event_date >= now() - interval '24 months'`,
      [id]
    );
    const openIssuesRes = await pool.query(
      `SELECT COUNT(*) FROM inspection_events
       WHERE opening_id = $1 AND passed = false
       AND event_date = (SELECT MAX(event_date) FROM inspection_events WHERE opening_id = $1)`,
      [id]
    );

    const { score, factors } = computeHealthScore({
      installDate: opening.install_date,
      lastServiceDate: opening.last_service_date,
      serviceEventsLast12Months: parseInt(serviceCountRes.rows[0].count, 10),
      failedInspectionsLast24Months: parseInt(failedInspectionsRes.rows[0].count, 10),
      openComplianceIssues: parseInt(openIssuesRes.rows[0].count, 10),
      fireRated: opening.fire_rated,
    });

    await pool.query("UPDATE openings SET health_score = $1, updated_at = now() WHERE id = $2", [score, id]);
    await pool.query(
      "INSERT INTO health_score_history (opening_id, score, factors) VALUES ($1, $2, $3)",
      [id, score, factors]
    );

    res.json({ score, factors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Portfolio-wide list, filterable by property/building/type/health threshold —
// the dashboard's main query. Always scoped to the caller's organization.
openingsRouter.get("/", async (req: AuthedRequest, res) => {
  const { building_id, property_id, opening_type, max_health_score } = req.query;
  const orgId = req.auth!.organizationId;
  const conditions: string[] = [];
  const values: any[] = [];

  if (building_id) {
    values.push(building_id);
    conditions.push(`building_id = $${values.length}`);
  }
  if (property_id) {
    values.push(property_id);
    conditions.push(`building_id IN (SELECT id FROM buildings WHERE property_id = $${values.length})`);
  }
  if (opening_type) {
    values.push(opening_type);
    conditions.push(`opening_type = $${values.length}`);
  }
  if (max_health_score) {
    values.push(max_health_score);
    conditions.push(`health_score <= $${values.length}`);
  }
  values.push(orgId);
  conditions.push(`id IN (${openingsForOrgSubquery(values.length)})`);

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  try {
    const result = await pool.query(
      `SELECT * FROM openings ${whereClause} ORDER BY health_score ASC NULLS LAST LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
