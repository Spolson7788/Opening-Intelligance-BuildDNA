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
  buildPrivatePhotoUploadKey,
  getPresignedPrivatePhotoUploadUrl,
  getPresignedPrivatePhotoReadUrl,
  headPrivatePhoto,
  verifyStoredPhoto,
  verifyPrivatePhotoRetrieval,
  isStorageKeyInOpeningScope,
  maximumMediaBytes,
  promotePrivatePhotoObject,
  assertStorageConfigured,
} from "../services/storage";
import { canonicalPayloadHash } from "../services/syncProtocol";

export const photosRouter = Router();
photosRouter.use(requireAuth);
photosRouter.use(enforceRolePermissions);
photosRouter.use(auditLog);

async function assertOpeningInOrg(openingId: string, orgId: string, queryable: any = pool): Promise<boolean> {
  const result = await queryable.query(
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
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
const recoverOfflinePhotoReservationSchema = reserveOfflinePhotoSchema.omit({ client_operation_id: true });

async function assertPhotoTarget(openingId: string, targetType: z.infer<typeof offlinePhotoTarget>, targetId: string, queryable: any = pool) {
  if (targetType === "opening") return targetId === openingId;
  const tableAndKey: Record<Exclude<z.infer<typeof offlinePhotoTarget>, "opening">, string> = {
    frame: "opening_frames",
    door_leaf: "door_leaves",
    hardware_component: "hardware_components",
    service_event: "service_events",
    inspection_event: "inspection_events",
  };
  const result = await queryable.query(
    `SELECT 1 FROM ${tableAndKey[targetType]} WHERE id=$1 AND opening_id=$2`,
    [targetId, openingId],
  );
  return result.rows.length > 0;
}

function reservationMatches(
  existing: any,
  requested: z.infer<typeof reserveOfflinePhotoSchema> & { actor_user_id: string },
) {
  return existing.photo_id === requested.photo_id &&
    existing.opening_id === requested.opening_id &&
    existing.target_type === requested.target_type &&
    existing.target_id === requested.target_id &&
    existing.content_type === requested.content_type &&
    Number(existing.byte_size) === requested.byte_size &&
    existing.sha256_checksum === requested.sha256_checksum &&
    existing.original_filename === requested.original_filename &&
    existing.actor_user_id === requested.actor_user_id &&
    existing.device_id === requested.device_id &&
    (existing.latitude === null ? requested.latitude === undefined : Number(existing.latitude) === requested.latitude) &&
    (existing.longitude === null ? requested.longitude === undefined : Number(existing.longitude) === requested.longitude);
}

export async function createOrReplayPhotoReservation(
  organizationId: string,
  requested: z.infer<typeof reserveOfflinePhotoSchema> & { actor_user_id: string },
) {
  const key = buildPrivatePhotoStorageKey(
    organizationId, requested.opening_id, requested.photo_id, requested.content_type,
  );
  const uploadKey = buildPrivatePhotoUploadKey(
    organizationId, requested.opening_id, requested.client_operation_id, requested.content_type,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO photo_upload_reservations
        (organization_id, opening_id, photo_id, operation_id, target_type, target_id,
         storage_object_key, upload_object_key, original_filename, content_type, byte_size, sha256_checksum,
         actor_user_id, device_id, latitude, longitude, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now() + interval '5 minutes')
       ON CONFLICT DO NOTHING RETURNING *`,
      [organizationId, requested.opening_id, requested.photo_id, requested.client_operation_id,
        requested.target_type, requested.target_id, key, uploadKey, requested.original_filename,
        requested.content_type, requested.byte_size, requested.sha256_checksum,
        requested.actor_user_id, requested.device_id, requested.latitude ?? null, requested.longitude ?? null],
    );
    const existing = await client.query(
      `SELECT * FROM photo_upload_reservations
       WHERE organization_id=$1 AND operation_id=$2 FOR UPDATE`,
      [organizationId, requested.client_operation_id],
    );
    const reservation = existing.rows[0];
    if (!reservation) { await client.query("ROLLBACK"); return { conflict: "photo_identity_reused" as const }; }
    if (!reservationMatches(reservation, requested)) {
      await client.query("ROLLBACK"); return { conflict: "idempotency_key_reused" as const };
    }
    const refreshed = reservation.status === "verified" ? { rows: [reservation] } : await client.query(
      `UPDATE photo_upload_reservations SET expires_at=now() + interval '5 minutes' WHERE id=$1 RETURNING *`,
      [reservation.id],
    );
    await client.query("COMMIT");
    return { reservation: refreshed.rows[0], created: inserted.rows.length === 1, key };
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
}

// Legacy clients did not persist the operation ID beside the retained media
// blob. This read-only recovery endpoint lets the authenticated original actor
// recover an existing immutable reservation by permanent photo identity and
// exact metadata before the client creates or sends a replacement operation.
photosRouter.post("/offline/recover-reservation", async (req: AuthedRequest, res) => {
  const parsed = recoverOfflinePhotoReservationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;
  if (!(await assertOpeningInOrg(b.opening_id, orgId))) return res.status(403).json({ error: "forbidden" });
  if (!(await assertPhotoTarget(b.opening_id, b.target_type, b.target_id))) {
    return res.status(400).json({ error: "photo_target_not_in_opening" });
  }
  const result = await pool.query(
    `SELECT * FROM photo_upload_reservations WHERE organization_id=$1 AND photo_id=$2`,
    [orgId, b.photo_id],
  );
  const reservation = result.rows[0];
  if (!reservation) return res.status(404).json({ error: "reservation_not_found" });
  if (!reservationMatches(reservation, { ...b, client_operation_id: reservation.operation_id,
    actor_user_id: userId })) {
    return res.status(409).json({ error: "legacy_reservation_identity_conflict" });
  }
  return res.json({
    photo_id: reservation.photo_id,
    client_operation_id: reservation.operation_id,
    status: reservation.status,
  });
});

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
  if (b.byte_size > maximumMediaBytes(b.content_type)) {
    return res.status(413).json({ error: "media_too_large" });
  }
  if (!(await assertOpeningInOrg(b.opening_id, orgId))) return res.status(403).json({ error: "forbidden" });
  if (!(await assertPhotoTarget(b.opening_id, b.target_type, b.target_id))) {
    return res.status(400).json({ error: "photo_target_not_in_opening" });
  }

  try {
    // Fail before creating an immutable reservation when no private storage
    // backend exists. A configuration error must not strand a database row
    // that never had an upload authorization.
    assertStorageConfigured();
    const requested = { ...b, actor_user_id: userId };
    const result = await createOrReplayPhotoReservation(orgId, requested);
    if (result.conflict) return res.status(409).json({ error: result.conflict });
    const { reservation, created } = result;
    const uploadUrl = reservation.status === "verified" ? undefined : await getPresignedPrivatePhotoUploadUrl({
      key: reservation.upload_object_key,
      contentType: b.content_type,
      byteSize: b.byte_size,
      sha256Checksum: b.sha256_checksum,
      photoId: b.photo_id,
    });

    return res.status(created ? 201 : 200).json({
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
  payload_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  schema_version: z.number().int().positive(),
  app_version: z.string().min(1).max(100),
  protocol_version: z.number().int().positive(),
});

photosRouter.post("/offline/confirm", async (req: AuthedRequest, res) => {
  const parsed = confirmOfflinePhotoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reserved = await client.query(
      `SELECT * FROM photo_upload_reservations
       WHERE organization_id=$1 AND operation_id=$2 AND photo_id=$3 FOR UPDATE`,
      [orgId, b.client_operation_id, b.photo_id],
    );
    const reservation = reserved.rows[0];
    if (!reservation) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "reservation_not_found" });
    }

    const payloadHash = canonicalPayloadHash({
      operation_type: "confirm_media",
      entity_type: "photo",
      photo_id: reservation.photo_id,
      opening_id: reservation.opening_id,
      target_type: reservation.target_type,
      target_id: reservation.target_id,
      storage_object_key: reservation.storage_object_key,
      original_filename: reservation.original_filename,
      content_type: reservation.content_type,
      byte_size: Number(reservation.byte_size),
      sha256_checksum: reservation.sha256_checksum,
      actor_user_id: reservation.actor_user_id,
      device_id: reservation.device_id,
      latitude: reservation.latitude === null ? null : Number(reservation.latitude),
      longitude: reservation.longitude === null ? null : Number(reservation.longitude),
    });
    const prior = await client.query(
      `SELECT * FROM sync_operation_receipts WHERE organization_id=$1 AND operation_id=$2`,
      [orgId, b.client_operation_id],
    );
    // Repeat authorization and hierarchy checks while holding the immutable
    // reservation lock, immediately before accepting the storage object.
    if (!(await assertOpeningInOrg(reservation.opening_id, orgId, client))) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "forbidden" });
    }
    if (!(await assertPhotoTarget(reservation.opening_id, reservation.target_type, reservation.target_id, client))) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "photo_target_no_longer_in_opening" });
    }
    if (reservation.actor_user_id !== req.auth!.userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "reservation_actor_mismatch" });
    }

    if (prior.rows[0]) {
      if (prior.rows[0].payload_hash !== payloadHash || prior.rows[0].entity_id !== b.photo_id) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "idempotency_key_reused" });
      }
      const finalStored = await headPrivatePhoto(reservation.storage_object_key);
      const finalFailures = verifyStoredPhoto({ byteSize: Number(reservation.byte_size),
        contentType: reservation.content_type, sha256Checksum: reservation.sha256_checksum,
        photoId: reservation.photo_id }, finalStored);
      const finalRetrieval = finalFailures.length === 0 && await verifyPrivatePhotoRetrieval(
        reservation.storage_object_key, reservation.sha256_checksum, maximumMediaBytes(reservation.content_type));
      await client.query("ROLLBACK");
      if (!finalRetrieval) return res.status(409).json({ error: "verified_object_no_longer_authoritative" });
      return res.json({ ...prior.rows[0], status: "already_applied" });
    }

    const stored = await headPrivatePhoto(reservation.upload_object_key);
    const failures = verifyStoredPhoto({
      byteSize: Number(reservation.byte_size),
      contentType: reservation.content_type,
      sha256Checksum: reservation.sha256_checksum,
      photoId: reservation.photo_id,
    }, stored);
    if (stored.byteSize > maximumMediaBytes(reservation.content_type)) failures.push("media_too_large");
    if (failures.length) {
      await client.query(
        `UPDATE photo_upload_reservations SET status='failed', failure_code=$1 WHERE id=$2`,
        [failures.join(","), reservation.id],
      );
      await client.query("COMMIT");
      return res.status(409).json({ error: "stored_object_verification_failed", failures });
    }
    const retrievalVerified = await verifyPrivatePhotoRetrieval(
      reservation.upload_object_key,
      reservation.sha256_checksum,
      maximumMediaBytes(reservation.content_type),
    );
    if (!retrievalVerified) {
      await client.query(
        `UPDATE photo_upload_reservations SET status='failed', failure_code='authorized_retrieval_checksum_mismatch' WHERE id=$1`,
        [reservation.id],
      );
      await client.query("COMMIT");
      return res.status(409).json({ error: "authorized_retrieval_verification_failed", failures: ["checksum_mismatch"] });
    }
    if (!stored.etag) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "stored_object_etag_missing" });
    }
    await promotePrivatePhotoObject({ uploadKey: reservation.upload_object_key,
      finalKey: reservation.storage_object_key, sourceEtag: stored.etag });
    const finalStored = await headPrivatePhoto(reservation.storage_object_key);
    const finalFailures = verifyStoredPhoto({ byteSize: Number(reservation.byte_size),
      contentType: reservation.content_type, sha256Checksum: reservation.sha256_checksum,
      photoId: reservation.photo_id }, finalStored);
    const finalRetrievalVerified = finalFailures.length === 0 && await verifyPrivatePhotoRetrieval(
      reservation.storage_object_key, reservation.sha256_checksum, maximumMediaBytes(reservation.content_type));
    if (!finalRetrievalVerified) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "final_object_verification_failed", failures: finalFailures });
    }

    const targetColumns = {
      frame_id: reservation.target_type === "frame" ? reservation.target_id : null,
      door_leaf_id: reservation.target_type === "door_leaf" ? reservation.target_id : null,
      hardware_component_id: reservation.target_type === "hardware_component" ? reservation.target_id : null,
    };
    const photo = await client.query(
      `INSERT INTO photos
        (id, opening_id, organization_id, related_entity_type, related_entity_id, storage_url,
         media_type, latitude, longitude, taken_at, uploaded_by_user_id, frame_id, door_leaf_id, hardware_component_id,
         client_operation_id, original_filename, content_type, byte_size, sha256_checksum,
         storage_object_key, upload_state, storage_verified_at, authorized_retrieval_verified_at,
         captured_by_device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'verified',now(),now(),$20)
       RETURNING *`,
      [reservation.photo_id, reservation.opening_id, orgId, reservation.target_type, reservation.target_id,
        `private:${reservation.storage_object_key}`, mediaTypeForContentType(reservation.content_type),
        reservation.latitude, reservation.longitude, req.auth!.userId, targetColumns.frame_id, targetColumns.door_leaf_id,
        targetColumns.hardware_component_id, reservation.operation_id, reservation.original_filename,
        reservation.content_type, reservation.byte_size, reservation.sha256_checksum,
        reservation.storage_object_key, reservation.device_id],
    );
    const normalizedRecordHash = createHash("sha256").update(JSON.stringify(photo.rows[0])).digest("hex");
    const receipt = await client.query(
      `INSERT INTO sync_operation_receipts
        (organization_id, opening_id, operation_id, operation_type, entity_type, entity_id,
         payload_hash, resulting_server_revision, status, actor_user_id, device_id,
         schema_version, app_version, protocol_version, normalized_record_hash,
         media_object_verified, authorized_retrieval_verified, response_payload)
       VALUES ($1,$2,$3,'confirm_media','photo',$4,$5,1,'accepted',$6,$7,$8,$9,$10,$11,true,true,$12)
       RETURNING *`,
      [orgId, reservation.opening_id, reservation.operation_id, reservation.photo_id, payloadHash,
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
    await deleteObject(reservation.upload_object_key).catch(() => undefined);
    return res.status(201).json(receipt.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err.message?.startsWith("Photo storage is not configured")) {
      return res.status(503).json({ error: "storage_not_configured" });
    }
    if (err.code === "23505") {
      return res.status(409).json({ error: "idempotency_conflict" });
    }
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
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
  storage_object_key: z.string().optional(),
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
}).refine((value) => value.storage_object_key || value.storage_url, { message: "storage_object_key_required" });

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

    if (b.storage_object_key && !isStorageKeyInOpeningScope(b.storage_object_key, orgId, b.opening_id)) {
      return res.status(400).json({ error: "storage_object_key_outside_opening_scope" });
    }
    const storageUrl = b.storage_object_key ? buildPublicUrl(b.storage_object_key) : b.storage_url!;
    const result = await pool.query(
      `INSERT INTO photos
        (opening_id, related_entity_type, related_entity_id, storage_url, storage_object_key, media_type, latitude, longitude,
         taken_at, uploaded_by_user_id, frame_id, door_leaf_id, hardware_component_id, client_operation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (opening_id, client_operation_id) WHERE client_operation_id IS NOT NULL
       DO UPDATE SET opening_id=EXCLUDED.opening_id RETURNING *`,
      [
        b.opening_id, b.related_entity_type ?? "opening", b.related_entity_id ?? null,
        storageUrl, b.storage_object_key ?? null, mediaType, b.latitude ?? null, b.longitude ?? null, b.taken_at ?? null, userId,
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

export async function processPhotoDeletionJobs(input: {
  organizationId?: string;
  operatorUserId?: string;
  limit?: number;
  deletePrivateObject?: (key: string) => Promise<void>;
}) {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
  const deleter = input.deletePrivateObject ?? deleteObject;
  const claimed = await pool.query(
    `WITH candidates AS (
       SELECT photo_id FROM photo_deletion_jobs
       WHERE ($1::uuid IS NULL OR organization_id=$1) AND attempt_count < 8
         AND (status='pending'
           OR (status='retry_wait' AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '1 minute'))
           OR (status='processing' AND last_attempt_at < now() - interval '5 minutes'))
       ORDER BY requested_at
       FOR UPDATE SKIP LOCKED LIMIT $2
     )
     UPDATE photo_deletion_jobs jobs
     SET status='processing', attempt_count=attempt_count+1, last_attempt_at=now(), last_error_code=NULL
     FROM candidates WHERE jobs.photo_id=candidates.photo_id RETURNING jobs.*`,
    [input.organizationId, limit],
  );
  let finalized = 0;
  let retrying = 0;
  for (const job of claimed.rows) {
    try {
      await deleter(job.storage_object_key);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO audit_log (organization_id,user_id,action,method,path,request_body,status_code)
           VALUES ($1,$2,'Finalized private photo deletion','WORKER','photo-deletion-jobs',
             jsonb_build_object('photo_id',$3::text,'attempt_count',$4::int),204)`,
          [job.organization_id, input.operatorUserId ?? job.requested_by_user_id, job.photo_id, job.attempt_count],
        );
        await client.query("DELETE FROM photos WHERE id=$1 AND organization_id=$2", [job.photo_id, job.organization_id]);
        await client.query("COMMIT");
        finalized += 1;
      } catch (error) {
        await client.query("ROLLBACK"); throw error;
      } finally { client.release(); }
    } catch (error) {
      await pool.query(
        `UPDATE photo_deletion_jobs SET status='retry_wait', last_error_code='object_delete_failed'
         WHERE photo_id=$1 AND organization_id=$2`, [job.photo_id, job.organization_id],
      );
      retrying += 1;
    }
  }
  return { claimed: claimed.rows.length, finalized, retrying };
}

photosRouter.post("/deletion-jobs/process", async (req: AuthedRequest, res) => {
  if (!new Set(["admin", "facilities_manager"]).has(req.auth!.role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const parsed = z.object({ limit: z.number().int().min(1).max(25).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await processPhotoDeletionJobs({
    organizationId: req.auth!.organizationId, operatorUserId: req.auth!.userId, limit: parsed.data.limit,
  });
  return res.json(result);
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
    const key = photo.storage_object_key as string | null;

    // Legacy rows without a private-object identity have no managed private
    // object to finalize. Private rows are retained until storage deletion is
    // confirmed, so a failed delete can never create an untracked object.
    if (!key) {
      await pool.query("DELETE FROM photos WHERE id=$1", [id]);
      return res.status(204).send();
    }

    await pool.query(
      `INSERT INTO photo_deletion_jobs
        (photo_id, organization_id, opening_id, storage_object_key, requested_by_user_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (photo_id) DO NOTHING`,
      [photo.id, orgId, photo.opening_id, key, req.auth!.userId],
    );

    try {
      await deleteObject(key);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM photos WHERE id=$1", [id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.status(204).send();
    } catch (cleanupErr) {
      await pool.query(
        `UPDATE photo_deletion_jobs
         SET status='retry_wait', attempt_count=attempt_count+1,
             last_attempt_at=now(), last_error_code='object_delete_failed'
         WHERE photo_id=$1`,
        [id],
      );
      console.error("Private photo deletion deferred", { photoId: id });
      return res.status(202).json({ status: "deletion_pending", photo_id: id });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
