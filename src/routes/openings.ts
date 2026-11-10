import { databaseRoute } from '../db/databaseRoute';
import { acquireClient } from '../db/acquireClient';
import { openingLabel } from "../services/openingLabels";
import { convertOpeningConfiguration } from "../services/openingConfiguration";
import { hasDimension } from "../lib/inchMeasure";
import {purchasingReview} from "../services/purchasingReview";
import { Router, Response } from "express";
import { randomUUID } from "node:crypto";


import { z } from "zod";
import { pool } from "../db/pool";
import { computeHealthScore } from "../services/healthScore";
import { requireAuth, AuthedRequest, isMissingSchema } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { buildingsForOrgSubquery, openingsForOrgSubquery, photoVisibleSql, serviceEventVisibleSql } from "../db/tenantScope";

export const openingsRouter = Router();
openingsRouter.use(requireAuth);
openingsRouter.use(enforceRolePermissions);
openingsRouter.use(auditLog);

function forbidden(res: Response) {
  return res.status(403).json({ error: "forbidden" });
}

async function rowsOrEmpty(sql: string, params: unknown[]) {
  try {
    return await pool.query(sql, params);
  } catch (error) {
    if (isMissingSchema(error)) return { rows: [] as any[] };
    throw error;
  }
}

// Load an opening together with its hardware, service/inspection history, and
// photos so every single-opening endpoint returns the same shape the field-app
// and dashboard detail views expect. by-qr and by-code (the field app's scan
// and manual-entry entry points) previously returned only the bare opening row,
// so a scanned/looked-up opening showed no photos, hardware, or history at all.
async function hydrateOpening(openingRow: any, orgId: string) {
  const openingId = openingRow.id;
  const [frame, leaves, hardware, serviceEvents, inspections, photos, retiredHardware, purchasingSends, deficiencies] = await Promise.all([
    pool.query("SELECT * FROM opening_frames WHERE opening_id = $1", [openingId]),
    pool.query("SELECT * FROM door_leaves WHERE opening_id = $1 ORDER BY CASE leaf_role WHEN 'single' THEN 0 WHEN 'active' THEN 1 ELSE 2 END", [openingId]),
    pool.query("SELECT * FROM current_hardware_components WHERE opening_id = $1 ORDER BY install_date", [openingId]),
    pool.query(`SELECT * FROM service_events WHERE opening_id = $1 AND ${serviceEventVisibleSql("service_events", 2)} ORDER BY event_date DESC`, [openingId, orgId]),
    pool.query("SELECT * FROM inspection_events WHERE opening_id = $1 ORDER BY event_date DESC", [openingId]),
    pool.query(`SELECT * FROM photos WHERE opening_id = $1 AND ${photoVisibleSql("photos", 2)} ORDER BY created_at DESC`, [openingId, orgId]),
    pool.query("SELECT * FROM hardware_components WHERE opening_id=$1 AND lifecycle_state='retired' ORDER BY id", [openingId]),
    rowsOrEmpty("SELECT id, hardware_component_id, sent_by_user_id, sent_to, note, delivery_mode, document_ids, reference_sha256s, created_at FROM purchasing_sends WHERE opening_id=$1 ORDER BY created_at DESC", [openingId]),
    rowsOrEmpty("SELECT * FROM fire_door_deficiencies WHERE opening_id=$1 ORDER BY created_at DESC", [openingId]),
  ]);
  return {
    ...openingRow,
    frame: frame.rows[0] ?? null,
    door_leaves: leaves.rows,
    hardware_components: hardware.rows,
    retired_hardware_components: retiredHardware.rows,
    service_events: serviceEvents.rows,
    inspection_events: inspections.rows,
    photos: photos.rows.map(({ inline_bytes: _inline, ...photo }: { inline_bytes?: Buffer }) => photo),
    purchasing_sends: purchasingSends.rows,
    fire_door_deficiencies: deficiencies.rows,
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
  expected_revision: z.number().int().positive().nullable().optional(),
  id: z.string().uuid().optional(),
  material: z.string().optional(),
  frame_type: z.string().optional(),
  width_in: z.number().positive().nullable().optional(),
  height_in: z.number().positive().nullable().optional(),
  fire_rated: z.boolean().optional(),
  condition: z.enum(["good", "worn", "failed", "unverified"]).optional(),
  notes: z.string().optional(),
});

const leafSchema = z.object({
  expected_revision: z.number().int().positive().nullable().optional(),
  id: z.string().uuid().optional(),
  leaf_role: z.enum(["single", "active", "inactive"]),
  handing: z.string().optional(),
  material: z.string().optional(),
  width_in: z.number().positive().nullable().optional(),
  height_in: z.number().positive().nullable().optional(),
  thickness_in: z.number().positive().nullable().optional(),
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
openingsRouter.put("/:id/frame", databaseRoute(async (req: AuthedRequest, res) => {
  const parsed = frameSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const opening = await getOpeningForOrg(req.params.id, req.auth!.organizationId);
  if (!opening) return res.status(404).json({ error: "not_found" });
  const b = parsed.data;
  const widthSet = hasDimension(b, "width_in");
  const heightSet = hasDimension(b, "height_in");
  const result = await pool.query(
    `INSERT INTO opening_frames
      (id, opening_id, material, frame_type, width_in, height_in, fire_rated, condition, notes)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
     WHERE $10::bigint IS NULL OR EXISTS (SELECT 1 FROM opening_frames WHERE opening_id=$2 AND revision=$10)
     ON CONFLICT (opening_id) DO UPDATE SET
       material=EXCLUDED.material, frame_type=EXCLUDED.frame_type,
       width_in=CASE WHEN $12::boolean THEN $5::numeric ELSE opening_frames.width_in END,
       height_in=CASE WHEN $13::boolean THEN $6::numeric ELSE opening_frames.height_in END,
       fire_rated=EXCLUDED.fire_rated, condition=EXCLUDED.condition,
       notes=EXCLUDED.notes, updated_at=now(), revision=opening_frames.revision + CASE WHEN $10::bigint IS NULL THEN 0 ELSE 1 END
     WHERE ($11::uuid IS NULL OR opening_frames.id=$11) AND
       (opening_frames.revision=$10 OR ($10::bigint IS NULL AND ROW(opening_frames.material,opening_frames.frame_type,opening_frames.width_in,opening_frames.height_in,opening_frames.fire_rated,opening_frames.condition,opening_frames.notes)
         IS NOT DISTINCT FROM ROW(EXCLUDED.material,EXCLUDED.frame_type,CASE WHEN $12::boolean THEN $5::numeric ELSE opening_frames.width_in END,CASE WHEN $13::boolean THEN $6::numeric ELSE opening_frames.height_in END,EXCLUDED.fire_rated,EXCLUDED.condition,EXCLUDED.notes)))
     RETURNING *`,
    [b.id ?? randomUUID(), opening.id, b.material ?? null, b.frame_type ?? null, widthSet ? b.width_in ?? null : null,
     heightSet ? b.height_in ?? null : null, b.fire_rated ?? false, b.condition ?? "unverified", b.notes ?? null, b.expected_revision ?? null, b.id ?? null,
     widthSet, heightSet]
  );
  if (!result.rows[0]) {
    const current = await pool.query("SELECT revision FROM opening_frames WHERE opening_id=$1", [opening.id]);
    return res.status(409).json({ error: "revision_conflict", server_revision: current.rows[0] ? Number(current.rows[0].revision) : null });
  }
  res.json(result.rows[0]);
}));

// A role identifies a physical leaf within an opening, not a viewing direction.
// POST is idempotent on (opening_id, leaf_role) so offline retries do not duplicate leaves.
openingsRouter.post("/:id/door-leaves", databaseRoute(async (req: AuthedRequest, res) => {
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
  const widthSet = hasDimension(b, "width_in");
  const heightSet = hasDimension(b, "height_in");
  const thicknessSet = hasDimension(b, "thickness_in");
  const result = await pool.query(
    `INSERT INTO door_leaves
      (id, opening_id, leaf_role, handing, material, width_in, height_in, thickness_in, fire_rated, condition, notes)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
     WHERE $12::bigint IS NULL OR EXISTS (SELECT 1 FROM door_leaves WHERE opening_id=$2 AND revision=$12 AND leaf_role=$3)
     ON CONFLICT (opening_id, leaf_role) DO UPDATE SET
       handing=EXCLUDED.handing, material=EXCLUDED.material,
       width_in=CASE WHEN $14::boolean THEN $6::numeric ELSE door_leaves.width_in END,
       height_in=CASE WHEN $15::boolean THEN $7::numeric ELSE door_leaves.height_in END,
       thickness_in=CASE WHEN $16::boolean THEN $8::numeric ELSE door_leaves.thickness_in END,
       fire_rated=EXCLUDED.fire_rated,
       condition=EXCLUDED.condition, notes=EXCLUDED.notes, updated_at=now(), revision=door_leaves.revision + CASE WHEN $12::bigint IS NULL THEN 0 ELSE 1 END
     WHERE ($13::uuid IS NULL OR door_leaves.id=$13) AND
       (door_leaves.revision=$12 OR ($12::bigint IS NULL AND ROW(door_leaves.handing,door_leaves.material,door_leaves.width_in,door_leaves.height_in,door_leaves.thickness_in,door_leaves.fire_rated,door_leaves.condition,door_leaves.notes)
         IS NOT DISTINCT FROM ROW(EXCLUDED.handing,EXCLUDED.material,
           CASE WHEN $14::boolean THEN $6::numeric ELSE door_leaves.width_in END,
           CASE WHEN $15::boolean THEN $7::numeric ELSE door_leaves.height_in END,
           CASE WHEN $16::boolean THEN $8::numeric ELSE door_leaves.thickness_in END,
           EXCLUDED.fire_rated,EXCLUDED.condition,EXCLUDED.notes)))
     RETURNING *`,
    [b.id ?? randomUUID(), opening.id, b.leaf_role, b.handing ?? null, b.material ?? null, widthSet ? b.width_in ?? null : null,
     heightSet ? b.height_in ?? null : null, thicknessSet ? b.thickness_in ?? null : null, b.fire_rated ?? false,
     b.condition ?? "unverified", b.notes ?? null, b.expected_revision ?? null, b.id ?? null,
     widthSet, heightSet, thicknessSet]
  );
  if (!result.rows[0]) {
    const current = await pool.query("SELECT revision FROM door_leaves WHERE opening_id=$1 AND leaf_role=$2", [opening.id, b.leaf_role]);
    return res.status(409).json({ error: "revision_conflict", server_revision: current.rows[0] ? Number(current.rows[0].revision) : null });
  }
  res.status(201).json(result.rows[0]);
}));

openingsRouter.post("/:id/configuration", databaseRoute(async (req: AuthedRequest, res) => {
  const parsed = z.object({ opening_configuration: z.enum(["single", "pair"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const opening = await getOpeningForOrg(req.params.id, req.auth!.organizationId);
  if (!opening) return res.status(404).json({ error: "not_found" });
  const client = await acquireClient(res); if (!client) return;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM openings WHERE id=$1 FOR UPDATE", [opening.id]);
    const converted = await convertOpeningConfiguration(client, opening.id, parsed.data.opening_configuration);
    await client.query("COMMIT");
    res.json(converted);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
}));

// Completion is a backend fact. It requires the whole physical opening hierarchy.
openingsRouter.post("/:id/complete", databaseRoute(async (req: AuthedRequest, res) => {
  const opening = await getOpeningForOrg(req.params.id, req.auth!.organizationId);
  if (!opening) return res.status(404).json({ error: "not_found" });
  const [frame, leaves, hardware] = await Promise.all([
    pool.query("SELECT condition FROM opening_frames WHERE opening_id=$1", [opening.id]),
    pool.query("SELECT leaf_role,condition FROM door_leaves WHERE opening_id=$1", [opening.id]),
    pool.query("SELECT review_state,condition FROM current_hardware_components WHERE opening_id=$1", [opening.id]),
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
  missing.push(...(frame.rows.some((r:any)=>!["good","worn","failed"].includes(r.condition)) ? ["frame_condition"] : []),
      ...(leaves.rows.some((r:any)=>!["good","worn","failed"].includes(r.condition)) ? ["leaf_condition"] : []),
      ...(hardware.rows.some((r:any)=>!["good","worn","failed"].includes(r.condition)) ? ["hardware_condition"] : []));
    if (missing.length) return res.status(409).json({ error: "opening_incomplete", missing });
  const result = await pool.query(
    `UPDATE openings SET completion_state='complete', completed_at=COALESCE(completed_at,now()),
       completed_by_user_id=COALESCE(completed_by_user_id,$2), status='active', updated_at=now()
     WHERE id=$1 RETURNING *`,
    [opening.id, req.auth!.userId]
  );
  res.json(result.rows[0]);
}));

openingsRouter.get("/:id/purchasing-eligibility", databaseRoute(async (req: AuthedRequest, res) => {
  if(!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'invalid_opening'});
  const c = await acquireClient(res); if (!c) return;try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result=await purchasingReview(c,req.auth!.organizationId,[req.params.id]);await c.query('COMMIT');
  if(!result)return res.status(404).json({error:'not_found'});
  res.set('Cache-Control','no-store').json({...result,opening_id:req.params.id,opening_complete:result.openings[0].opening_complete});
  }catch(e){await c.query('ROLLBACK');res.status(500).json({error:'review_failed'});}finally{c.release();}
}));

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
openingsRouter.post("/bulk-import", databaseRoute(async (req: AuthedRequest, res) => {
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
}));

// Batch QR generation for an entire building — pairs with bulk import:
// import 200 openings from a CSV, then get all 200 QR codes in one request
// instead of 200 round trips, ready to lay out on a print-friendly label
// sheet. Registered ABOVE /:id on purpose: Express matches routes in
// registration order, and /:id is a single-segment wildcard that would
// otherwise swallow /qr-codes (treating "qr-codes" as the id value) before
// this handler is ever reached — caught by testing the route directly
// rather than trusting registration order would sort itself out.
openingsRouter.get("/qr-codes", databaseRoute(async (req: AuthedRequest, res) => {
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

    const labels = [];
    for (const o of openings.rows) labels.push(await openingLabel(pool, o.id, orgId));
    const items = labels.filter(label => label?.eligible);
    const blocked = labels.filter(label => label && !label.eligible).map(label => ({ id: label!.id, opening_code: label!.opening_code, missing: label!.missing }));
    res.json({ building_id, count: items.length, items, blocked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
}));

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

    res.json(await hydrateOpening(opening.rows[0], orgId));
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
    res.json(await hydrateOpening(result.rows[0], orgId));
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
    res.json(await hydrateOpening(result.rows[0], orgId));
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
    const label = await openingLabel(pool, id, orgId);
    if (!label) return res.status(404).json({ error: "not_found" });
    if (!label.eligible) return res.status(409).json({ error: "label_not_ready", missing: label.missing });
    res.json(label);
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
      `SELECT COUNT(*) FROM service_events se
       WHERE se.opening_id = $1 AND se.event_date >= now() - interval '12 months' AND ${serviceEventVisibleSql('se', 2)}`,
      [id, orgId]
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
  const geoValues = [...values];
  const geoConditions = [...conditions];
  if (typeof req.query.state_code === "string" && req.query.state_code !== "") {
    if (!/^[A-Za-z]{2}$/.test(req.query.state_code)) return res.status(400).json({ error: "invalid_state_code" });
    geoValues.push(req.query.state_code.toUpperCase());
    geoConditions.push(`building_id IN (SELECT b.id FROM buildings b JOIN properties p ON p.id = b.property_id WHERE p.state_code = $${geoValues.length})`);
  }
  if (typeof req.query.county_fips === "string" && req.query.county_fips !== "") {
    if (!/^\d{5}$/.test(req.query.county_fips)) return res.status(400).json({ error: "invalid_county_fips" });
    geoValues.push(req.query.county_fips);
    geoConditions.push(`building_id IN (SELECT b.id FROM buildings b JOIN properties p ON p.id = b.property_id WHERE p.county_fips = $${geoValues.length})`);
  }
  geoValues.push(req.auth!.userId);
  geoConditions.push(`id IN (
    SELECT area_o.id FROM openings area_o
    JOIN buildings area_b ON area_b.id = area_o.building_id
    WHERE oi_private.caller_area_allows($${geoValues.length}::uuid, area_b.property_id)
  )`);

  try {
    let result;
    try {
      result = await pool.query(
        `SELECT * FROM openings WHERE ${geoConditions.join(" AND ")} ORDER BY health_score ASC NULLS LAST LIMIT 500`,
        geoValues
      );
    } catch (error) {
      if (!isMissingSchema(error)) throw error;
      result = await pool.query(
        `SELECT * FROM openings WHERE ${conditions.join(" AND ")} ORDER BY health_score ASC NULLS LAST LIMIT 500`,
        values
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
