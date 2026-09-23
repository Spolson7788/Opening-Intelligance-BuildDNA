import { Router, Response } from "express";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { openingQrUrl } from "../services/openingQr";
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
  const [frame, leaves, hardware, serviceEvents, inspections, photos] = await Promise.all([
    pool.query("SELECT * FROM opening_frames WHERE opening_id = $1", [openingId]),
    pool.query("SELECT * FROM door_leaves WHERE opening_id = $1 ORDER BY CASE leaf_role WHEN 'single' THEN 0 WHEN 'active' THEN 1 ELSE 2 END", [openingId]),
    pool.query("SELECT * FROM hardware_components WHERE opening_id = $1 ORDER BY install_date", [openingId]),
    pool.query("SELECT * FROM service_events WHERE opening_id = $1 ORDER BY event_date DESC", [openingId]),
    pool.query("SELECT * FROM inspection_events WHERE opening_id = $1 ORDER BY event_date DESC", [openingId]),
    pool.query("SELECT * FROM photos WHERE opening_id = $1 ORDER BY created_at DESC", [openingId]),
  ]);
  return {
    ...openingRow,
    frame: frame.rows[0] ?? null,
    door_leaves: leaves.rows,
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
  opening_configuration: z.enum(["single", "pair"]).optional(),
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
  const qrToken = randomUUID();
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
         fire_rated, life_safety_critical, is_electrified, install_date, latitude, longitude, qr_token, status,
         opening_configuration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_capture',$13)
       RETURNING *`,
      [
        body.opening_code, body.building_id, body.floor_label ?? null,
        body.location_description ?? null, body.opening_type,
        body.fire_rated ?? false, body.life_safety_critical ?? false, body.is_electrified ?? false,
        body.install_date ?? null, body.latitude ?? null, body.longitude ?? null,
        qrToken, body.opening_configuration ?? "single",
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "opening_code already exists" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const frameSchema = z.object({
  id: z.string().uuid().optional(),
  material: z.string().optional(),
  frame_type: z.string().optional(),
  width_in: z.number().positive().optional(),
  height_in: z.number().positive().optional(),
  fire_rated: z.boolean().optional(),
  condition: z.enum(["good", "worn", "failed", "unverified"]).optional(),
  notes: z.string().optional(),
});

const leafSchema = z.object({
  id: z.string().uuid().optional(),
  leaf_role: z.enum(["single", "active", "inactive"]),
  handing: z.string().optional(),
  material: z.string().optional(),
  width_in: z.number().positive().optional(),
  height_in: z.number().positive().optional(),
  thickness_in: z.number().positive().optional(),
  fire_rated: z.boolean().optional(),
  condition: z.enum(["good", "worn", "failed", "unverified"]).optional(),
  notes: z.string().optional(),
});

async function getOpeningForOrg(openingId: string, orgId: string) {
  const result = await pool.query(
    `SELECT * FROM openings WHERE id = $1 AND id IN (${openingsForOrgSubquery(2)})`,
    [openingId, orgId]
  );
  return result.rows[0] ?? null;
}

// One frame per opening. PUT is deliberately idempotent for field retries.
openingsRouter.put("/:id/frame", async (req: AuthedRequest, res) => {
  const parsed = frameSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const opening = await getOpeningForOrg(req.params.id, req.auth!.organizationId);
  if (!opening) return res.status(404).json({ error: "not_found" });
  const b = parsed.data;
  const result = await pool.query(
    `INSERT INTO opening_frames
      (id, opening_id, material, frame_type, width_in, height_in, fire_rated, condition, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (opening_id) DO UPDATE SET
       material=EXCLUDED.material, frame_type=EXCLUDED.frame_type,
       width_in=EXCLUDED.width_in, height_in=EXCLUDED.height_in,
       fire_rated=EXCLUDED.fire_rated, condition=EXCLUDED.condition,
       notes=EXCLUDED.notes, updated_at=now()
     RETURNING *`,
    [b.id ?? randomUUID(), opening.id, b.material ?? null, b.frame_type ?? null, b.width_in ?? null,
     b.height_in ?? null, b.fire_rated ?? false, b.condition ?? "unverified", b.notes ?? null]
  );
  res.json(result.rows[0]);
});

// A role identifies a physical leaf within an opening, not a viewing direction.
// POST is idempotent on (opening_id, leaf_role) so offline retries do not duplicate leaves.
openingsRouter.post("/:id/door-leaves", async (req: AuthedRequest, res) => {
  const parsed = leafSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const opening = await getOpeningForOrg(req.params.id, req.auth!.organizationId);
  if (!opening) return res.status(404).json({ error: "not_found" });
  const b = parsed.data;
  if (opening.opening_configuration === "single" && b.leaf_role !== "single") {
    return res.status(409).json({ error: "single_opening_requires_single_leaf" });
  }
  if (opening.opening_configuration === "pair" && b.leaf_role === "single") {
    return res.status(409).json({ error: "paired_opening_requires_active_or_inactive_leaf" });
  }
  const result = await pool.query(
    `INSERT INTO door_leaves
      (id, opening_id, leaf_role, handing, material, width_in, height_in, thickness_in, fire_rated, condition, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (opening_id, leaf_role) DO UPDATE SET
       handing=EXCLUDED.handing, material=EXCLUDED.material,
       width_in=EXCLUDED.width_in, height_in=EXCLUDED.height_in,
       thickness_in=EXCLUDED.thickness_in, fire_rated=EXCLUDED.fire_rated,
       condition=EXCLUDED.condition, notes=EXCLUDED.notes, updated_at=now()
     RETURNING *`,
    [b.id ?? randomUUID(), opening.id, b.leaf_role, b.handing ?? null, b.material ?? null, b.width_in ?? null,
     b.height_in ?? null, b.thickness_in ?? null, b.fire_rated ?? false,
     b.condition ?? "unverified", b.notes ?? null]
  );
  res.status(201).json(result.rows[0]);
});

// Completion is a backend fact. It requires the whole physical opening hierarchy.
openingsRouter.post("/:id/complete", async (req: AuthedRequest, res) => {
  const opening = await getOpeningForOrg(req.params.id, req.auth!.organizationId);
  if (!opening) return res.status(404).json({ error: "not_found" });
  const [frame, leaves, hardware] = await Promise.all([
    pool.query("SELECT 1 FROM opening_frames WHERE opening_id=$1", [opening.id]),
    pool.query("SELECT leaf_role FROM door_leaves WHERE opening_id=$1", [opening.id]),
    pool.query("SELECT review_state FROM hardware_components WHERE opening_id=$1", [opening.id]),
  ]);
  const roles = new Set(leaves.rows.map((row) => row.leaf_role));
  const leavesComplete = opening.opening_configuration === "pair"
    ? roles.has("active") && roles.has("inactive")
    : roles.has("single");
  const missing = [
    ...(frame.rows.length ? [] : ["frame"]),
    ...(leavesComplete ? [] : [opening.opening_configuration === "pair" ? "active_and_inactive_leaves" : "single_leaf"]),
    ...(hardware.rows.length ? [] : ["hardware_component"]),
    ...(hardware.rows.some((row) => row.review_state !== "reviewed") ? ["hardware_review"] : []),
  ];
  if (missing.length) return res.status(409).json({ error: "opening_incomplete", missing });
  const result = await pool.query(
    `UPDATE openings SET completion_state='complete', completed_at=COALESCE(completed_at,now()),
       completed_by_user_id=COALESCE(completed_by_user_id,$2), status='active', updated_at=now()
     WHERE id=$1 RETURNING *`,
    [opening.id, req.auth!.userId]
  );
  res.json(result.rows[0]);
});

openingsRouter.get("/:id/purchasing-eligibility", async (req: AuthedRequest, res) => {
  const opening = await getOpeningForOrg(req.params.id, req.auth!.organizationId);
  if (!opening) return res.status(404).json({ error: "not_found" });
  const components = await pool.query(
    "SELECT * FROM hardware_components WHERE opening_id=$1 ORDER BY created_at",
    [opening.id]
  );
  const complete = opening.completion_state === "complete";
  const decisions = components.rows.map((component) => {
    const reasons: string[] = [];
    if (!complete) reasons.push("opening_not_complete");
    if (component.review_state !== "reviewed") reasons.push("component_not_reviewed");
    if (component.identity_status !== "established") reasons.push("identity_unresolved");
    if (!component.replacement_required || !["worn", "failed"].includes(component.condition)) {
      reasons.push("replacement_not_required");
    }
    return { component_id: component.id, eligible: reasons.length === 0, reasons };
  });
  res.json({ opening_id: opening.id, opening_complete: complete, decisions });
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

  // A duplicate opening code is an expected row-level result, not an
  // exceptional transaction failure. ON CONFLICT keeps the connection usable
  // so valid rows after a duplicate are still inserted and reported.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const qrToken = randomUUID();
      const result = await pool.query(
        `INSERT INTO openings
          (opening_code, building_id, floor_label, location_description, opening_type,
           fire_rated, life_safety_critical, is_electrified, install_date, qr_token, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_capture')
         ON CONFLICT (opening_code) DO NOTHING
         RETURNING id`,
        [
          row.opening_code, building_id, row.floor_label ?? null,
          row.location_description ?? null, row.opening_type,
          row.fire_rated ?? false, row.life_safety_critical ?? false, row.is_electrified ?? false,
          row.install_date ?? null, qrToken,
        ]
      );
      if (result.rows.length === 0) {
        results.push({ row: i, opening_code: row.opening_code, status: "error", error: "opening_code already exists" });
      } else {
        results.push({ row: i, opening_code: row.opening_code, status: "created", id: result.rows[0].id });
      }
    } catch {
      results.push({ row: i, opening_code: row.opening_code, status: "error", error: "insert_failed" });
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
      `SELECT o.id, o.opening_code, o.qr_token, o.opening_type, o.floor_label, o.location_description, p.name AS facility_name, b.name AS building_name
       FROM openings o JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id
       WHERE o.building_id = $1 ORDER BY o.opening_code`,
      [building_id]
    );

    const items = await Promise.all(
      openings.rows.map(async (o) => {
        const payload = openingQrUrl(o.qr_token);
        const qr_data_url = await QRCode.toDataURL(payload, { width: 300, margin: 4 });
        return {
          id: o.id,
          opening_code: o.opening_code,
          opening_type: o.opening_type,
          floor_label: o.floor_label,
          location_description: o.location_description,
          qr_data_url,
          payload, facility_name: o.facility_name, building_name: o.building_name,
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
