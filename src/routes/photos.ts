import { Router } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery } from "../db/tenantScope";
import {
  getPresignedUploadUrl,
  buildStorageKey,
  buildPublicUrl,
  isAllowedPhotoContentType,
  mediaTypeForContentType,
  deleteObject,
  buildPrivatePhotoStorageKey,
  getPresignedPrivatePhotoUploadUrl,
  getPresignedPrivatePhotoReadUrl,
  headPrivatePhoto,
  verifyStoredPhoto,
  verifyPrivatePhotoRetrieval,
  isStorageKeyInOpeningScope,
} from "../services/storage";

export const photosRouter = Router();
photosRouter.use(requireAuth);
photosRouter.use(enforceRolePermissions);
photosRouter.use(auditLog);

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

const offlinePhotoTarget = z.enum([
  "opening", "frame", "door_leaf", "hardware_component", "service_event", "inspection_event",
]);

const reserveOfflinePhotoSchema = z.object({
  photo_id: z.string().uuid(),
  client_operation_id: z.string().uuid(),
  opening_id: z.string().uuid(),
  target_type: offlinePhotoTarget,
  target_id: z.string().uuid(),
  original_filename: z.string().min(1).max(255),
  content_type: z.string(),
  byte_size: z.number().int().positive(),
  sha256_checksum: z.string().regex(/^[0-9a-f]{64}$/),
  device_id: z.string().uuid(),
});

async function assertPhotoTarget(openingId: string, targetType: z.infer<typeof offlinePhotoTarget>, targetId: string) {
  if (targetType === "opening") return targetId === openingId;
  const tableAndKey: Record<Exclude<z.infer<typeof offlinePhotoTarget>, "opening">, string> = {
    frame: "opening_frames",
    door_leaf: "door_leaves",
    hardware_component: "hardware_components",
    service_event: "service_events",
    inspection_event: "inspection_events",
  };
  const result = await pool.query(
    `SELECT 1 FROM ${tableAndKey[targetType]} WHERE id=$1 AND opening_id=$2`,
    [targetId, openingId],
  );
  return result.rows.length > 0;
}

function reservationMatches(existing: any, requested: z.infer<typeof reserveOfflinePhotoSchema>) {
  return existing.photo_id === requested.photo_id &&
    existing.opening_id === requested.opening_id &&
    existing.target_type === requested.target_type &&
    existing.target_id === requested.target_id &&
    existing.content_type === requested.content_type &&
    Number(existing.byte_size) === requested.byte_size &&
    existing.sha256_checksum === requested.sha256_checksum &&
    existing.device_id === requested.device_id;
}

// Offline protocol step 1: reserve one immutable private object identity.
// Replaying the same operation returns the same reservation and a fresh
// short-lived upload authorization. Reusing the operation for different bytes
// or a different hierarchy target is rejected.
photosRouter.post("/offline/reserve", async (req: AuthedRequest, res) => {
  const parsed = reserveOfflinePhotoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;

  if (!isAllowedPhotoContentType(b.content_type)) {
    return res.status(400).json({ error: "unsupported_content_type" });
  }
  if (!(await assertOpeningInOrg(b.opening_id, orgId))) return res.status(403).json({ error: "forbidden" });
  if (!(await assertPhotoTarget(b.opening_id, b.target_type, b.target_id))) {
    return res.status(400).json({ error: "photo_target_not_in_opening" });
  }

  try {
    const existing = await pool.query(
      `SELECT * FROM photo_upload_reservations WHERE organization_id=$1 AND operation_id=$2`,
      [orgId, b.client_operation_id],
    );
    let reservation = existing.rows[0];
    if (reservation && !reservationMatches(reservation, b)) {
      return res.status(409).json({ error: "idempotency_key_reused" });
    }

    const key = reservation?.storage_object_key ??
      buildPrivatePhotoStorageKey(orgId, b.opening_id, b.photo_id, b.content_type);
    const uploadUrl = await getPresignedPrivatePhotoUploadUrl({
      key,
      contentType: b.content_type,
      byteSize: b.byte_size,
      sha256Checksum: b.sha256_checksum,
      photoId: b.photo_id,
    });

    if (!reservation) {
      const inserted = await pool.query(
        `INSERT INTO photo_upload_reservations
          (organization_id, opening_id, photo_id, operation_id, target_type, target_id,
           storage_object_key, original_filename, content_type, byte_size, sha256_checksum,
           actor_user_id, device_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now() + interval '5 minutes')
         RETURNING *`,
        [orgId, b.opening_id, b.photo_id, b.client_operation_id, b.target_type, b.target_id,
          key, b.original_filename, b.content_type, b.byte_size, b.sha256_checksum, userId, b.device_id],
      );
      reservation = inserted.rows[0];
    } else {
      const refreshed = await pool.query(
        `UPDATE photo_upload_reservations SET expires_at=now() + interval '5 minutes'
         WHERE id=$1 RETURNING *`,
        [reservation.id],
      );
      reservation = refreshed.rows[0];
    }

    return res.status(existing.rows[0] ? 200 : 201).json({
      photo_id: reservation.photo_id,
      client_operation_id: reservation.operation_id,
      storage_object_key: reservation.storage_object_key,
      upload_url: uploadUrl,
      expires_at: reservation.expires_at,
      status: reservation.status,
    });
  } catch (err: any) {
    if (err.message?.startsWith("Photo storage is not configured")) {
      return res.status(503).json({ error: "storage_not_configured" });
    }
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  }
});

const confirmOfflinePhotoSchema = z.object({
  photo_id: z.string().uuid(),
  client_operation_id: z.string().uuid(),
  payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
  schema_version: z.number().int().positive(),
  app_version: z.string().min(1).max(100),
  protocol_version: z.number().int().positive(),
});

photosRouter.post("/offline/confirm", async (req: AuthedRequest, res) => {
  const parsed = confirmOfflinePhotoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;

  const prior = await pool.query(
    `SELECT * FROM sync_operation_receipts WHERE organization_id=$1 AND operation_id=$2`,
    [orgId, b.client_operation_id],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].payload_hash !== b.payload_hash || prior.rows[0].entity_id !== b.photo_id) {
      return res.status(409).json({ error: "idempotency_key_reused" });
    }
    return res.json({ ...prior.rows[0], status: "already_applied" });
  }

  const reserved = await pool.query(
    `SELECT * FROM photo_upload_reservations
     WHERE organization_id=$1 AND operation_id=$2 AND photo_id=$3`,
    [orgId, b.client_operation_id, b.photo_id],
  );
  const reservation = reserved.rows[0];
  if (!reservation) return res.status(404).json({ error: "reservation_not_found" });
  if (!(await assertOpeningInOrg(reservation.opening_id, orgId))) return res.status(403).json({ error: "forbidden" });

  try {
    const stored = await headPrivatePhoto(reservation.storage_object_key);
    const failures = verifyStoredPhoto({
      byteSize: Number(reservation.byte_size),
      contentType: reservation.content_type,
      sha256Checksum: reservation.sha256_checksum,
      photoId: reservation.photo_id,
    }, stored);
    if (failures.length) {
      await pool.query(
        `UPDATE photo_upload_reservations SET status='failed', failure_code=$1 WHERE id=$2`,
        [failures.join(","), reservation.id],
      );
      return res.status(409).json({ error: "stored_object_verification_failed", failures });
    }
    if (!(await verifyPrivatePhotoRetrieval(reservation.storage_object_key, reservation.sha256_checksum))) {
      await pool.query(
        `UPDATE photo_upload_reservations SET status='failed', failure_code='authorized_retrieval_checksum_mismatch' WHERE id=$1`,
        [reservation.id],
      );
      return res.status(409).json({
        error: "authorized_retrieval_verification_failed",
        failures: ["checksum_mismatch"],
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const targetColumns = {
        frame_id: reservation.target_type === "frame" ? reservation.target_id : null,
        door_leaf_id: reservation.target_type === "door_leaf" ? reservation.target_id : null,
        hardware_component_id: reservation.target_type === "hardware_component" ? reservation.target_id : null,
      };
      const photo = await client.query(
        `INSERT INTO photos
          (id, opening_id, organization_id, related_entity_type, related_entity_id, storage_url,
           media_type, taken_at, uploaded_by_user_id, frame_id, door_leaf_id, hardware_component_id,
           client_operation_id, original_filename, content_type, byte_size, sha256_checksum,
           storage_object_key, upload_state, storage_verified_at, authorized_retrieval_verified_at,
           captured_by_device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'verified',now(),now(),$18)
         ON CONFLICT (opening_id, client_operation_id) WHERE client_operation_id IS NOT NULL
         DO UPDATE SET opening_id=EXCLUDED.opening_id
         RETURNING *`,
        [reservation.photo_id, reservation.opening_id, orgId, reservation.target_type, reservation.target_id,
          `private:${reservation.storage_object_key}`, mediaTypeForContentType(reservation.content_type),
          req.auth!.userId, targetColumns.frame_id, targetColumns.door_leaf_id,
          targetColumns.hardware_component_id, reservation.operation_id, reservation.original_filename,
          reservation.content_type, reservation.byte_size, reservation.sha256_checksum,
          reservation.storage_object_key, reservation.device_id],
      );
      const normalizedRecordHash = createHash("sha256").update(JSON.stringify(photo.rows[0])).digest("hex");
      const receipt = await client.query(
        `INSERT INTO sync_operation_receipts
          (organization_id, opening_id, operation_id, operation_type, entity_type, entity_id,
           payload_hash, resulting_server_revision, status, actor_user_id, device_id,
           schema_version, app_version, protocol_version, normalized_record_hash, response_payload)
         VALUES ($1,$2,$3,'confirm_media','photo',$4,$5,1,'accepted',$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [orgId, reservation.opening_id, reservation.operation_id, reservation.photo_id, b.payload_hash,
          req.auth!.userId, reservation.device_id, b.schema_version, b.app_version,
          b.protocol_version, normalizedRecordHash, JSON.stringify(photo.rows[0])],
      );
      await client.query(
        `INSERT INTO sync_audit_events
          (organization_id, opening_id, operation_id, entity_type, entity_id, action,
           resulting_server_revision, actor_user_id, device_id, changed_fields)
         VALUES ($1,$2,$3,'photo',$4,'photo_verified',1,$5,$6,$7)`,
        [orgId, reservation.opening_id, reservation.operation_id, reservation.photo_id,
          req.auth!.userId, reservation.device_id,
          ["storage_object_key", "sha256_checksum", "upload_state"]],
      );
      await client.query(
        `UPDATE photo_upload_reservations SET status='verified', uploaded_at=COALESCE(uploaded_at,now()),
         verified_at=now(), failure_code=NULL WHERE id=$1`,
        [reservation.id],
      );
      await client.query("COMMIT");
      return res.status(201).json(receipt.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message?.startsWith("Photo storage is not configured")) {
      return res.status(503).json({ error: "storage_not_configured" });
    }
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  }
});

photosRouter.get("/:id/access", async (req: AuthedRequest, res) => {
  const photo = await pool.query(
    `SELECT p.* FROM photos p WHERE p.id=$1 AND p.opening_id IN (${openingsForOrgSubquery(2)})`,
    [req.params.id, req.auth!.organizationId],
  );
  if (!photo.rows[0]) return res.status(404).json({ error: "not_found" });
  if (!photo.rows[0].storage_object_key) return res.status(409).json({ error: "legacy_media_not_private" });
  try {
    const url = await getPresignedPrivatePhotoReadUrl(photo.rows[0].storage_object_key);
    return res.json({ url, expires_in_seconds: 300 });
  } catch (err: any) {
    if (err.message?.startsWith("Photo storage is not configured")) {
      return res.status(503).json({ error: "storage_not_configured" });
    }
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  }
});

const presignSchema = z.object({
  opening_id: z.string().uuid(),
  content_type: z.string(),
  client_operation_id: z.string().uuid().optional(),
});

// Step 1: client asks for a place to upload. We never touch the image bytes —
// the client PUTs directly to storage using the returned URL. Keeps large photo
// uploads off the API server entirely.
photosRouter.post("/presign", async (req: AuthedRequest, res) => {
  const parsed = presignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { opening_id, content_type, client_operation_id } = parsed.data;
  const orgId = req.auth!.organizationId;

  if (!isAllowedPhotoContentType(content_type)) {
    return res.status(400).json({ error: "unsupported_content_type" });
  }

  try {
    if (!(await assertOpeningInOrg(opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    // The operation ID makes the object key stable across retries. A dropped
    // confirmation response can therefore be retried without leaving another
    // orphaned object in storage.
    const key = buildStorageKey(orgId, opening_id, content_type, client_operation_id);
    const uploadUrl = await getPresignedUploadUrl(key, content_type);
    const storageUrl = buildPublicUrl(key);

    res.json({ uploadUrl, storageUrl, key });
  } catch (err: any) {
    if (err.message?.startsWith("Photo storage is not configured")) {
      return res.status(503).json({ error: "storage_not_configured", detail: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const createPhotoSchema = z.object({
  opening_id: z.string().uuid(),
  storage_key: z.string().optional(),
  storage_url: z.string().url().optional(),
  content_type: z.string(),
  related_entity_type: z.enum(["opening", "frame", "door_leaf", "hardware_component", "service_event", "inspection_event"]).optional(),
  related_entity_id: z.string().uuid().optional(),
  frame_id: z.string().uuid().optional(),
  door_leaf_id: z.string().uuid().optional(),
  hardware_component_id: z.string().uuid().optional(),
  client_operation_id: z.string().uuid().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  taken_at: z.string().optional(),
}).refine((value) => value.storage_key || value.storage_url, { message: "storage_key_required" });

// Step 2: client confirms the upload succeeded and we record it. New clients
// send the server-issued storage key; the server validates its tenant/opening
// scope and derives the URL. Legacy URL input remains temporarily compatible.
// A HEAD-object check remains a later hardening item. media_type is derived from content_type here, not trusted
// as a separate client-supplied field, so there's exactly one place
// (storage.ts) that decides what counts as a photo vs. a video.
photosRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createPhotoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;
  const mediaType = mediaTypeForContentType(b.content_type);

  try {
    if (!(await assertOpeningInOrg(b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const associations = [b.frame_id, b.door_leaf_id, b.hardware_component_id].filter(Boolean);
    if (associations.length > 1) return res.status(400).json({ error: "one_photo_target_only" });
    if (b.frame_id) {
      const target = await pool.query("SELECT 1 FROM opening_frames WHERE id=$1 AND opening_id=$2", [b.frame_id, b.opening_id]);
      if (!target.rows.length) return res.status(400).json({ error: "frame_not_in_opening" });
    }
    if (b.door_leaf_id) {
      const target = await pool.query("SELECT 1 FROM door_leaves WHERE id=$1 AND opening_id=$2", [b.door_leaf_id, b.opening_id]);
      if (!target.rows.length) return res.status(400).json({ error: "door_leaf_not_in_opening" });
    }
    if (b.hardware_component_id) {
      const target = await pool.query("SELECT 1 FROM hardware_components WHERE id=$1 AND opening_id=$2", [b.hardware_component_id, b.opening_id]);
      if (!target.rows.length) return res.status(400).json({ error: "hardware_not_in_opening" });
    }

    if (b.storage_key && !isStorageKeyInOpeningScope(b.storage_key, orgId, b.opening_id)) {
      return res.status(400).json({ error: "storage_key_outside_opening_scope" });
    }
    const storageUrl = b.storage_key ? buildPublicUrl(b.storage_key) : b.storage_url!;
    const result = await pool.query(
      `INSERT INTO photos
        (opening_id, related_entity_type, related_entity_id, storage_url, storage_key, media_type, latitude, longitude,
         taken_at, uploaded_by_user_id, frame_id, door_leaf_id, hardware_component_id, client_operation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (opening_id, client_operation_id) WHERE client_operation_id IS NOT NULL
       DO UPDATE SET opening_id=EXCLUDED.opening_id RETURNING *`,
      [
        b.opening_id, b.related_entity_type ?? "opening", b.related_entity_id ?? null,
        storageUrl, b.storage_key ?? null, mediaType, b.latitude ?? null, b.longitude ?? null, b.taken_at ?? null, userId,
        b.frame_id ?? null, b.door_leaf_id ?? null, b.hardware_component_id ?? null,
        b.client_operation_id ?? null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

photosRouter.get("/by-opening/:openingId", async (req: AuthedRequest, res) => {
  const { openingId } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    if (!(await assertOpeningInOrg(openingId, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const result = await pool.query(
      "SELECT * FROM photos WHERE opening_id = $1 ORDER BY created_at DESC",
      [openingId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

photosRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const photoResult = await pool.query(
      `SELECT p.* FROM photos p WHERE p.id = $1 AND p.opening_id IN (${openingsForOrgSubquery(2)})`,
      [id, orgId]
    );
    if (photoResult.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const photo = photoResult.rows[0];
    await pool.query("DELETE FROM photos WHERE id = $1", [id]);

    // Best-effort cleanup of the underlying object — don't fail the request if this errors,
    // the DB record is already gone which is what the client cares about.
    try {
      const url = new URL(photo.storage_url);
      const key = url.pathname.replace(/^\//, "");
      await deleteObject(key);
    } catch (cleanupErr) {
      console.error("Failed to delete underlying storage object:", cleanupErr);
    }

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
