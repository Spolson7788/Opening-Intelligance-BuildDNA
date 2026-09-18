import { Router } from "express";
import { z } from "zod";
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
