import { Router, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { facilityScheduleAccess, SCHEDULE_WRITE_ROLES } from "../db/tenantScope";
import { getPresignedUploadUrl } from "../services/storage";
import { correctionsEnabled, kindMismatch, STALE_IMPORT_SQL } from "../services/scheduleKind";

// M1: store door / hardware schedules on a facility. No parsing.
// Who: admin or facilities_manager of the facility owner organization, or of a
// provider organization with an active facility assignment (immediate on
// assignment, gone on revocation). Everyone else is denied; unassigned
// facilities are indistinguishable from non-existent ones (404).
export const facilitySchedulesRouter = Router();
facilitySchedulesRouter.use(requireAuth, auditLog);

export const MAX_SCHEDULE_BYTES = 25 * 1024 * 1024;
export const SCHEDULE_CONTENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const uuid = z.string().uuid();
const contentType = z.string().refine((c) => Object.hasOwn(SCHEDULE_CONTENT_TYPES, c), "unsupported_content_type");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const byteSize = z.number().int().min(1).max(MAX_SCHEDULE_BYTES);
const kind = z.enum(["door", "hardware"]);

export function scheduleKeyPrefix(propertyId: string) {
  return `facility-schedules/${propertyId}/`;
}

function requireWriteRole(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!SCHEDULE_WRITE_ROLES.includes(req.auth!.role)) return res.status(403).json({ error: "insufficient_role_for_action" });
  return next();
}

const presignSchema = z.object({
  property_id: uuid, kind, content_type: contentType, byte_size: byteSize, sha256,
}).strict();

facilitySchedulesRouter.post("/presign", requireWriteRole, async (req: AuthedRequest, res) => {
  const parsed = presignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_schedule_upload" });
  const b = parsed.data;
  try {
    if (!(await facilityScheduleAccess(pool, b.property_id, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
    const key = `${scheduleKeyPrefix(b.property_id)}${randomUUID()}.${SCHEDULE_CONTENT_TYPES[b.content_type]}`;
    const uploadUrl = await getPresignedUploadUrl(key, b.content_type);
    return res.json({ uploadUrl, key });
  } catch (err: any) {
    if (String(err?.message || "").includes("not configured")) return res.status(503).json({ error: "storage_not_configured" });
    console.error("facility schedule presign failed");
    return res.status(500).json({ error: "internal_error" });
  }
});

const createSchema = z.object({
  property_id: uuid,
  schedule_id: uuid.optional(),
  kind,
  title: z.string().trim().min(1).max(200),
  original_filename: z.string().trim().min(1).max(255),
  storage_key: z.string().min(1).max(500),
  content_type: contentType,
  byte_size: byteSize,
  sha256,
}).strict();

facilitySchedulesRouter.post("/", requireWriteRole, async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_schedule_upload" });
  const b = parsed.data;
  const { organizationId, userId } = req.auth!;
  const prefix = scheduleKeyPrefix(b.property_id);
  const ext = SCHEDULE_CONTENT_TYPES[b.content_type];
  if (!b.storage_key.startsWith(prefix) || !/^[0-9a-f-]{36}\.[a-z]+$/.test(b.storage_key.slice(prefix.length)) || !b.storage_key.endsWith("." + ext)) {
    return res.status(400).json({ error: "storage_key_out_of_scope" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await facilityScheduleAccess(client, b.property_id, organizationId))) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    let scheduleId = b.schedule_id;
    let schedule;
    if (scheduleId) {
      schedule = (await client.query("SELECT * FROM facility_schedules WHERE id=$1 AND property_id=$2 FOR UPDATE", [scheduleId, b.property_id])).rows[0];
      if (!schedule) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      if (schedule.kind !== b.kind) { await client.query("ROLLBACK"); return res.status(409).json({ error: "schedule_kind_mismatch" }); }
      if (schedule.archived_at) { await client.query("ROLLBACK"); return res.status(409).json({ error: "schedule_archived" }); }
    } else {
      scheduleId = randomUUID();
      schedule = (await client.query(
        `INSERT INTO facility_schedules(id,property_id,created_by_organization_id,created_by_user_id,kind,title)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [scheduleId, b.property_id, organizationId, userId, b.kind, b.title])).rows[0];
    }
    const version = Number(schedule.head_version) + 1;
    const row = (await client.query(
      `INSERT INTO facility_schedule_versions(id,schedule_id,version,storage_key,original_filename,content_type,byte_size,sha256,uploaded_by_user_id,uploaded_by_organization_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,version,original_filename,content_type,byte_size,sha256,created_at`,
      [randomUUID(), scheduleId, version, b.storage_key, b.original_filename, b.content_type, b.byte_size, b.sha256, userId, organizationId])).rows[0];
    await client.query("UPDATE facility_schedules SET head_version=$2 WHERE id=$1", [scheduleId, version]);
    await client.query("COMMIT");
    return res.status(201).json({ schedule_id: scheduleId, property_id: b.property_id, kind: schedule.kind, title: schedule.title, version: row });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") return res.status(409).json({ error: "storage_key_already_recorded" });
    console.error("facility schedule create failed");
    return res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

// Read-only list for the field app, resolved from an opening the caller can see.
facilitySchedulesRouter.get("/by-opening/:openingId", async (req: AuthedRequest, res) => {
  const parsed = uuid.safeParse(req.params.openingId);
  if (!parsed.success) return res.status(400).json({ error: "invalid_opening" });
  try {
    const r = await pool.query("SELECT b.property_id FROM openings o JOIN buildings b ON b.id=o.building_id WHERE o.id=$1", [parsed.data]);
    const propertyId = r.rows[0]?.property_id;
    if (!propertyId || !(await facilityScheduleAccess(pool, propertyId, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
    return res.json(await listForProperty(propertyId, false));
  } catch {
    console.error("facility schedule list failed");
    return res.status(500).json({ error: "internal_error" });
  }
});

facilitySchedulesRouter.get("/by-property/:propertyId", async (req: AuthedRequest, res) => {
  const parsed = uuid.safeParse(req.params.propertyId);
  if (!parsed.success) return res.status(400).json({ error: "invalid_property" });
  try {
    if (!(await facilityScheduleAccess(pool, parsed.data, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
    return res.json(await listForProperty(parsed.data, req.query.include_archived === "1" || req.query.include_archived === "true"));
  } catch {
    console.error("facility schedule list failed");
    return res.status(500).json({ error: "internal_error" });
  }
});

async function listForProperty(propertyId: string, includeArchived: boolean) {
    const on = await correctionsEnabled(pool);
    const rows = (await pool.query(
      `SELECT s.id AS schedule_id, s.kind, s.title, s.head_version, s.created_at, ${on ? "s.archived_at" : "NULL::timestamptz AS archived_at"},
              v.id AS version_id, v.version, v.original_filename, v.content_type, v.byte_size, v.sha256,
              v.uploaded_by_organization_id, v.created_at AS uploaded_at
       FROM facility_schedules s JOIN facility_schedule_versions v ON v.schedule_id=s.id
       WHERE s.property_id=$1 AND ($2::boolean OR ${on ? "s.archived_at IS NULL" : "true"}) ORDER BY s.created_at DESC, v.version DESC`, [propertyId, includeArchived])).rows;
    const out: any[] = [];
    const byId = new Map<string, any>();
    for (const r of rows) {
      let s = byId.get(r.schedule_id);
      if (!s) { s = { id: r.schedule_id, kind: r.kind, title: r.title, head_version: Number(r.head_version), created_at: r.created_at, archived_at: r.archived_at ?? null, versions: [] }; byId.set(r.schedule_id, s); out.push(s); }
      s.versions.push({ id: r.version_id, version: Number(r.version), original_filename: r.original_filename, content_type: r.content_type,
        byte_size: Number(r.byte_size), sha256: r.sha256, uploaded_by_organization_id: r.uploaded_by_organization_id, uploaded_at: r.uploaded_at });
    }
    return out;
}

// M3B: correct the type of a stored schedule, archive / unarchive it.
// Same audience as uploads: admin / facilities_manager of the owner org or an
// actively assigned provider org. Every change writes an immutable
// facility_schedule_events row in the same transaction (enforced by trigger)
// plus the usual audit_log entry.
const kindBody = z.object({ kind, reason: z.string().trim().min(1).max(1000), acknowledge_mismatch: z.boolean().optional() }).strict();
const archiveBody = z.object({ reason: z.string().trim().min(1).max(1000).optional() }).strict();

async function lockSchedule(client: any, req: AuthedRequest, id: string) {
  if (!uuid.safeParse(id).success) return null;
  if (!(await correctionsEnabled(client))) return "disabled" as const;
  const s = (await client.query("SELECT * FROM facility_schedules WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!s || !(await facilityScheduleAccess(client, s.property_id, req.auth!.organizationId))) return null;
  return s;
}

facilitySchedulesRouter.post("/:id/kind", requireWriteRole, async (req: AuthedRequest, res) => {
  const parsed = kindBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_kind_change" });
  const b = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const s = await lockSchedule(client, req, req.params.id);
    if (s === "disabled") { await client.query("ROLLBACK"); return res.status(503).json({ error: "schedule_corrections_not_enabled" }); }
    if (!s) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    if (s.archived_at) { await client.query("ROLLBACK"); return res.status(409).json({ error: "schedule_archived" }); }
    if (s.kind === b.kind) { await client.query("ROLLBACK"); return res.status(409).json({ error: "kind_unchanged" }); }
    const uses = (await client.query(`SELECT i.id, i.status FROM schedule_imports i JOIN facility_schedule_versions v ON v.id IN (i.door_version_id, i.hardware_version_id)
      WHERE v.schedule_id=$1 ORDER BY i.created_at`, [s.id])).rows;
    const confirmed = uses.filter((u: any) => u.status === "confirmed").map((u: any) => u.id);
    if (confirmed.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "schedule_used_by_confirmed_import", import_ids: confirmed }); }
    const head = (await client.query("SELECT original_filename FROM facility_schedule_versions WHERE schedule_id=$1 AND version=$2", [s.id, s.head_version])).rows[0];
    const mismatch = head ? kindMismatch(b.kind, head.original_filename) : false;
    if (mismatch && b.acknowledge_mismatch !== true) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "kind_file_mismatch_unacknowledged", warning: `The current file (${head.original_filename}) looks like a ${b.kind === "door" ? "hardware" : "door"} schedule.` });
    }
    await client.query(`INSERT INTO facility_schedule_events(id,schedule_id,event,from_kind,to_kind,reason,mismatch_acknowledged,actor_user_id,actor_organization_id)
      VALUES($1,$2,'kind_changed',$3,$4,$5,$6,$7,$8)`, [randomUUID(), s.id, s.kind, b.kind, b.reason, mismatch, req.auth!.userId, req.auth!.organizationId]);
    await client.query("UPDATE facility_schedules SET kind=$2 WHERE id=$1", [s.id, b.kind]);
    await client.query("COMMIT");
    const stale = uses.filter((u: any) => u.status === "draft").map((u: any) => u.id);
    return res.json({ id: s.id, kind: b.kind, previous_kind: s.kind, mismatch_acknowledged: mismatch, stale_draft_import_ids: stale });
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    console.error("facility schedule kind change failed");
    return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});

async function setArchived(req: AuthedRequest, res: Response, archive: boolean) {
  const parsed = archiveBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_archive_request" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const s = await lockSchedule(client, req, req.params.id);
    if (s === "disabled") { await client.query("ROLLBACK"); return res.status(503).json({ error: "schedule_corrections_not_enabled" }); }
    if (!s) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    if (Boolean(s.archived_at) === archive) { await client.query("ROLLBACK"); return res.status(409).json({ error: archive ? "already_archived" : "not_archived" }); }
    await client.query(`INSERT INTO facility_schedule_events(id,schedule_id,event,reason,actor_user_id,actor_organization_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), s.id, archive ? "archived" : "unarchived", parsed.data.reason ?? null, req.auth!.userId, req.auth!.organizationId]);
    const row = (await client.query(archive
      ? "UPDATE facility_schedules SET archived_at=now(), archived_by_user_id=$2 WHERE id=$1 RETURNING archived_at"
      : "UPDATE facility_schedules SET archived_at=NULL, archived_by_user_id=NULL WHERE id=$1 AND $2::uuid IS NOT NULL RETURNING archived_at", [s.id, req.auth!.userId])).rows[0];
    await client.query("COMMIT");
    return res.json({ id: s.id, archived_at: row.archived_at ?? null });
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    console.error("facility schedule archive change failed");
    return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
}
facilitySchedulesRouter.post("/:id/archive", requireWriteRole, (req: AuthedRequest, res) => setArchived(req, res, true));
facilitySchedulesRouter.post("/:id/unarchive", requireWriteRole, (req: AuthedRequest, res) => setArchived(req, res, false));

// History (kind changes, archive / unarchive) for one schedule.
facilitySchedulesRouter.get("/:id/events", async (req: AuthedRequest, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: "not_found" });
  if (!(await correctionsEnabled(pool))) return res.status(503).json({ error: "schedule_corrections_not_enabled" });
  const s = (await pool.query("SELECT property_id FROM facility_schedules WHERE id=$1", [req.params.id])).rows[0];
  if (!s || !(await facilityScheduleAccess(pool, s.property_id, req.auth!.organizationId))) return res.status(404).json({ error: "not_found" });
  const r = await pool.query(`SELECT id, event, from_kind, to_kind, reason, mismatch_acknowledged, actor_user_id, actor_organization_id, created_at
    FROM facility_schedule_events WHERE schedule_id=$1 ORDER BY created_at, id`, [req.params.id]);
  return res.json(r.rows);
});
