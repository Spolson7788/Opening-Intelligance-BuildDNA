import { Router, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { facilityScheduleAccess, SCHEDULE_WRITE_ROLES } from "../db/tenantScope";
import { getPresignedUploadUrl } from "../services/storage";

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
    return res.json(await listForProperty(propertyId));
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
    return res.json(await listForProperty(parsed.data));
  } catch {
    console.error("facility schedule list failed");
    return res.status(500).json({ error: "internal_error" });
  }
});

async function listForProperty(propertyId: string) {
    const rows = (await pool.query(
      `SELECT s.id AS schedule_id, s.kind, s.title, s.head_version, s.created_at,
              v.id AS version_id, v.version, v.original_filename, v.content_type, v.byte_size, v.sha256,
              v.uploaded_by_organization_id, v.created_at AS uploaded_at
       FROM facility_schedules s JOIN facility_schedule_versions v ON v.schedule_id=s.id
       WHERE s.property_id=$1 ORDER BY s.created_at DESC, v.version DESC`, [propertyId])).rows;
    const out: any[] = [];
    const byId = new Map<string, any>();
    for (const r of rows) {
      let s = byId.get(r.schedule_id);
      if (!s) { s = { id: r.schedule_id, kind: r.kind, title: r.title, head_version: Number(r.head_version), created_at: r.created_at, versions: [] }; byId.set(r.schedule_id, s); out.push(s); }
      s.versions.push({ id: r.version_id, version: Number(r.version), original_filename: r.original_filename, content_type: r.content_type,
        byte_size: Number(r.byte_size), sha256: r.sha256, uploaded_by_organization_id: r.uploaded_by_organization_id, uploaded_at: r.uploaded_at });
    }
    return out;
}
