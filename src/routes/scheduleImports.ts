import { Router, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { facilityScheduleAccess, SCHEDULE_WRITE_ROLES } from "../db/tenantScope";
import { readScheduleFile } from "../services/scheduleFileReader";
import { parseDoorScheduleFile, parseHardwareScheduleFile, UnsupportedScheduleFormat } from "../services/scheduleParsing";
import { applyPlan, loadImport, planImport, Resolutions } from "../services/scheduleImport";
import { MAX_SCHEDULE_BYTES } from "./facilitySchedules";
import { correctionsEnabled, isImportStale, STALE_IMPORT_SQL } from "../services/scheduleKind";

// M2: parse a stored schedule version for one building, preview, confirm.
// Same audience as M1 uploads: admin / facilities_manager of the facility owner
// org or of an actively assigned provider org. Others get 403 (role) or 404.
export const scheduleImportsRouter = Router();
scheduleImportsRouter.use(requireAuth, auditLog);

const uuid = z.string().uuid();
const createBody = z.object({ building_id: uuid, door_version_id: uuid, hardware_version_id: uuid.optional() }).strict();
const resolutionsBody = z.object({
  rows: z.record(z.string(), z.object({ skip: z.boolean().optional(), mark: z.string().min(1).max(40).optional() }).strict()).optional(),
  set_map: z.record(z.string(), z.string().max(40).nullable()).optional(),
  row_sets: z.record(z.string(), z.string().max(40).nullable()).optional(),
  accept_items: z.array(uuid).max(5000).optional(),
  overwrite: z.array(z.string().max(200)).max(5000).optional(),
}).strict();
const confirmBody = z.object({ resolutions: resolutionsBody.default({}) }).strict();

function requireRole(req: AuthedRequest, res: Response): boolean {
  if (SCHEDULE_WRITE_ROLES.includes(req.auth!.role)) return true;
  res.status(403).json({ error: "insufficient_role_for_action" });
  return false;
}

async function versionFor(id: string) {
  return (await pool.query(
    `SELECT v.*, s.property_id, s.kind FROM facility_schedule_versions v JOIN facility_schedules s ON s.id=v.schedule_id WHERE v.id=$1`, [id])).rows[0];
}

async function accessibleImport(req: AuthedRequest, id: string) {
  const imp = (await pool.query("SELECT id, property_id FROM schedule_imports WHERE id=$1", [id])).rows[0];
  if (!imp) return null;
  return (await facilityScheduleAccess(pool, imp.property_id, req.auth!.organizationId)) ? imp : null;
}

scheduleImportsRouter.post("/", async (req: AuthedRequest, res: Response) => {
  if (!requireRole(req, res)) return;
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const b = parsed.data;
  const door = await versionFor(b.door_version_id);
  if (!door || !(await facilityScheduleAccess(pool, door.property_id, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
  if (door.kind !== "door") return res.status(400).json({ error: "door_version_required" });
  const hw = b.hardware_version_id ? await versionFor(b.hardware_version_id) : null;
  if (b.hardware_version_id && (!hw || hw.property_id !== door.property_id)) return res.status(404).json({ error: "not_found" });
  if (hw && hw.kind !== "hardware") return res.status(400).json({ error: "hardware_version_required" });
  const building = (await pool.query("SELECT id FROM buildings WHERE id=$1 AND property_id=$2", [b.building_id, door.property_id])).rows[0];
  if (!building) return res.status(404).json({ error: "building_not_found" });

  let doorParse, hwParse = null;
  try {
    doorParse = parseDoorScheduleFile(door.content_type, await readScheduleFile(door.storage_key, MAX_SCHEDULE_BYTES));
    if (hw) hwParse = parseHardwareScheduleFile(hw.content_type, await readScheduleFile(hw.storage_key, MAX_SCHEDULE_BYTES));
  } catch (e) {
    if (e instanceof UnsupportedScheduleFormat) return res.status(422).json({ error: e.message });
    return res.status(422).json({ error: "schedule_unreadable" });
  }
  const id = randomUUID();
  const report = { blocks: doorParse.blocks, issues: [...doorParse.issues, ...(hwParse?.issues ?? [])], misc_items_excluded: hwParse?.misc_items_excluded ?? 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO schedule_imports(id, property_id, building_id, door_version_id, hardware_version_id, parse_report, created_by_user_id, created_by_organization_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, door.property_id, b.building_id, door.id, hw?.id ?? null, JSON.stringify(report), req.auth!.userId, req.auth!.organizationId]);
    for (const r of doorParse.rows) {
      await client.query(`INSERT INTO schedule_rows(id, import_id, row_kind, schedule_name, source_sheet, source_row, raw, door_mark_raw, door_mark, room_name, room_number, to_room,
        elevation_type, configuration, description, width_in, height_in, thickness_in, door_material, frame_material, fire_rating_raw, fire_rating_minutes, hw_ref_raw, hw_set_key, closer, comments, issues)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [randomUUID(), id, r.row_kind, r.schedule_name, r.source_sheet, r.source_row, JSON.stringify(r.raw), r.door_mark_raw, r.door_mark, r.room_name, r.room_number, r.to_room,
          r.elevation_type, r.configuration, r.description, r.width_in, r.height_in, r.thickness_in, r.door_material, r.frame_material, r.fire_rating_raw, r.fire_rating_minutes,
          r.hw_ref_raw, r.hw_set_key, r.closer, r.comments, JSON.stringify(r.issues)]);
    }
    for (const s of hwParse?.sets ?? []) {
      const setId = randomUUID();
      await client.query("INSERT INTO schedule_hardware_sets(id, import_id, set_key, heading_raw, notes, furnished_by_others, source_table) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [setId, id, s.set_key, s.heading_raw, s.notes, s.furnished_by_others, s.source_table]);
      for (const it of s.items) await client.query(`INSERT INTO schedule_set_items(id, set_id, import_id, position, qty, description, catalog_raw, catalog, finish, finish_bhma, options,
          manufacturer_raw, manufacturer, furnished_by, item_type, component_type, needs_review, review_reasons) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [randomUUID(), setId, id, it.position, it.qty, it.description, it.catalog_raw, it.catalog, it.finish, it.finish_bhma, it.options,
          it.manufacturer_raw, it.manufacturer, it.furnished_by, it.item_type, it.component_type, it.needs_review, JSON.stringify(it.review_reasons)]);
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({ error: "import_create_failed" });
  } finally { client.release(); }
  return res.status(201).json({ id, status: "draft", rows: doorParse.rows.length, sets: hwParse?.sets.length ?? 0 });
});

scheduleImportsRouter.get("/by-property/:propertyId", async (req: AuthedRequest, res: Response) => {
  if (!requireRole(req, res)) return;
  if (!uuid.safeParse(req.params.propertyId).success || !(await facilityScheduleAccess(pool, req.params.propertyId, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
  const r = await pool.query(`SELECT i.id, i.building_id, b.name AS building_name, i.door_version_id, i.hardware_version_id, i.status, i.created_at, i.confirmed_at,
    ${(await correctionsEnabled(pool)) ? `(i.status='draft' AND ${STALE_IMPORT_SQL})` : "false"} AS stale
    FROM schedule_imports i JOIN buildings b ON b.id=i.building_id WHERE i.property_id=$1 ORDER BY i.created_at DESC`, [req.params.propertyId]);
  return res.json(r.rows);
});

async function preview(req: AuthedRequest, res: Response, resolutions: Resolutions) {
  if (!requireRole(req, res)) return;
  if (!uuid.safeParse(req.params.id).success || !(await accessibleImport(req, req.params.id))) return res.status(404).json({ error: "not_found" });
  const loaded = (await loadImport(pool, req.params.id))!;
  if (loaded.imp.status === "confirmed") return res.json({ import: summaryOf(loaded), result: loaded.imp.result, resolutions: loaded.imp.resolutions });
  const plan = await planImport(pool, loaded, resolutions);
  const stale = await isImportStale(pool, req.params.id);
  return res.json({ import: { ...summaryOf(loaded), stale }, rows: loaded.rows, sets: loaded.sets.map((s: any) => ({ ...s, items: loaded.items.filter((i: any) => i.set_id === s.id) })), plan });
}
function summaryOf(l: any) {
  const { imp } = l;
  return { id: imp.id, property_id: imp.property_id, building_id: imp.building_id, door_version_id: imp.door_version_id, hardware_version_id: imp.hardware_version_id,
    status: imp.status, created_at: imp.created_at, confirmed_at: imp.confirmed_at, parse_report: imp.parse_report };
}

scheduleImportsRouter.get("/:id", (req: AuthedRequest, res: Response) => preview(req, res, {}));
// Preview with draft resolutions (no writes).
scheduleImportsRouter.post("/:id/preview", (req: AuthedRequest, res: Response) => {
  const p = confirmBody.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid_request" });
  return preview(req, res, p.data.resolutions);
});

scheduleImportsRouter.post("/:id/confirm", async (req: AuthedRequest, res: Response) => {
  if (!requireRole(req, res)) return;
  const p = confirmBody.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid_request" });
  if (!uuid.safeParse(req.params.id).success || !(await accessibleImport(req, req.params.id))) return res.status(404).json({ error: "not_found" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the parent facility (property) row first, before any other read or write, so confirms on the
    // same facility serialize. Uses the existing lock-only grant (20260927143010): UPDATE(id) + WITH CHECK(false).
    // property_id is immutable on schedule_imports (schedule_imports_guard). The unique index stays as a backstop.
    const facilityLock = await client.query("SELECT id FROM properties WHERE id=(SELECT property_id FROM schedule_imports WHERE id=$1) FOR UPDATE", [req.params.id]);
    if (!facilityLock.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    const locked = (await client.query("SELECT * FROM schedule_imports WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
    if (locked.status === "confirmed") { await client.query("ROLLBACK"); return res.status(200).json({ already_confirmed: true, result: locked.result }); }
    // M3B: a schedule used by this draft changed type after it was started; restart the import.
    if (await isImportStale(client, locked.id)) { await client.query("ROLLBACK"); return res.status(409).json({ error: "import_stale_schedule_type_changed" }); }
    const loaded = (await loadImport(client, req.params.id))!;
    const plan = await planImport(client, loaded, p.data.resolutions);
    if (plan.blocked) { await client.query("ROLLBACK"); return res.status(409).json({ error: "unresolved_blockers", issues: plan.issues.filter((i) => i.severity === "blocker") }); }
    const counts = await applyPlan(client, locked, loaded, plan);
    const result = { ...counts, summary: plan.summary };
    await client.query("UPDATE schedule_imports SET status='confirmed', resolutions=$2, result=$3, confirmed_by_user_id=$4, confirmed_at=now() WHERE id=$1",
      [locked.id, JSON.stringify(p.data.resolutions), JSON.stringify(result), req.auth!.userId]);
    await client.query("COMMIT");
    return res.status(200).json({ already_confirmed: false, result });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({ error: "confirm_failed" });
  } finally { client.release(); }
});

// M2C: schedule follow-ups (openings imported without hardware).
// Read: any role in the owner org or an actively assigned provider org.
// Resolve (open -> resolved only, with a note): admin / facilities_manager there.
const followUpStatus = z.enum(["open", "resolved", "all"]);
const resolveBody = z.object({ note: z.string().trim().min(1).max(2000) }).strict();
const FOLLOW_UP_COLUMNS = `f.id, f.import_id, f.row_id, f.opening_id, f.reason, f.detail, f.status, f.created_at, f.resolved_at, f.resolved_by_user_id, f.resolution_note,
  o.schedule_door_mark AS door_mark, o.opening_code, i.building_id, b.name AS building_name, i.confirmed_at AS import_confirmed_at`;
const FOLLOW_UP_FROM = `FROM schedule_row_follow_ups f JOIN schedule_imports i ON i.id=f.import_id JOIN openings o ON o.id=f.opening_id JOIN buildings b ON b.id=i.building_id`;

scheduleImportsRouter.get("/follow-ups/by-property/:propertyId", async (req: AuthedRequest, res: Response) => {
  const status = followUpStatus.safeParse(req.query.status ?? "open");
  if (!status.success) return res.status(400).json({ error: "invalid_request" });
  if (!uuid.safeParse(req.params.propertyId).success || !(await facilityScheduleAccess(pool, req.params.propertyId, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
  const r = await pool.query(`SELECT ${FOLLOW_UP_COLUMNS} ${FOLLOW_UP_FROM} WHERE i.property_id=$1 AND ($2='all' OR f.status=$2) ORDER BY f.created_at DESC, o.schedule_door_mark`,
    [req.params.propertyId, status.data]);
  return res.json(r.rows);
});

scheduleImportsRouter.post("/follow-ups/:followUpId/resolve", async (req: AuthedRequest, res: Response) => {
  if (!uuid.safeParse(req.params.followUpId).success) return res.status(404).json({ error: "not_found" });
  const row = (await pool.query(`SELECT f.id, i.property_id FROM schedule_row_follow_ups f JOIN schedule_imports i ON i.id=f.import_id WHERE f.id=$1`, [req.params.followUpId])).rows[0];
  if (!row || !(await facilityScheduleAccess(pool, row.property_id, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
  if (!requireRole(req, res)) return;
  const body = resolveBody.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: "resolution_note_required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = (await client.query("SELECT status FROM schedule_row_follow_ups WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
    if (locked.status !== "open") { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_resolved" }); }
    await client.query("UPDATE schedule_row_follow_ups SET status='resolved', resolved_at=now(), resolved_by_user_id=$2, resolution_note=$3 WHERE id=$1",
      [row.id, req.auth!.userId, body.data.note]);
    const out = (await client.query(`SELECT ${FOLLOW_UP_COLUMNS} ${FOLLOW_UP_FROM} WHERE f.id=$1`, [row.id])).rows[0];
    await client.query("COMMIT");
    return res.json(out);
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({ error: "resolve_failed" });
  } finally { client.release(); }
});
