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
});

// Step 1: client asks for a place to upload. We never touch the image bytes —
// the client PUTs directly to storage using the returned URL. Keeps large photo
// uploads off the API server entirely.
photosRouter.post("/presign", async (req: AuthedRequest, res) => {
  const parsed = presignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { opening_id, content_type } = parsed.data;
  const orgId = req.auth!.organizationId;

  if (!isAllowedPhotoContentType(content_type)) {
    return res.status(400).json({ error: "unsupported_content_type" });
  }

  try {
    if (!(await assertOpeningInOrg(opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const key = buildStorageKey(orgId, opening_id, content_type);
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
  storage_url: z.string().url(),
  content_type: z.string(),
  related_entity_type: z.enum(["opening", "hardware_component", "service_event", "inspection_event"]).optional(),
  related_entity_id: z.string().uuid().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  taken_at: z.string().optional(),
});

// Step 2: client confirms the upload succeeded and we record it. Trusts the
// client's storage_url rather than re-verifying the object exists in S3 — fine
// for MVP scale, worth adding a HEAD-object check before this goes multi-tenant
// at real volume. media_type is derived from content_type here, not trusted
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

    const result = await pool.query(
      `INSERT INTO photos
        (opening_id, related_entity_type, related_entity_id, storage_url, media_type, latitude, longitude, taken_at, uploaded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        b.opening_id, b.related_entity_type ?? "opening", b.related_entity_id ?? null,
        b.storage_url, mediaType, b.latitude ?? null, b.longitude ?? null, b.taken_at ?? null, userId,
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
