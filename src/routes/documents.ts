import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { enforceRolePermissions } from "../middleware/permissions";
import { auditLog } from "../middleware/auditLog";
import { openingsForOrgSubquery, propertiesForOrgSubquery } from "../db/tenantScope";
import {
  getPresignedUploadUrl,
  buildDocumentStorageKey,
  buildPublicUrl,
  isAllowedDocumentContentType,
  deleteObject,
} from "../services/storage";

export const documentsRouter = Router();
documentsRouter.use(requireAuth);
documentsRouter.use(enforceRolePermissions);
documentsRouter.use(auditLog);

async function assertPropertyInOrg(propertyId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${propertiesForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [propertyId, orgId]
  );
  return result.rows.length > 0;
}

async function assertOpeningInOrg(openingId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM (${openingsForOrgSubquery(2)}) allowed WHERE allowed.id = $1`,
    [openingId, orgId]
  );
  return result.rows.length > 0;
}

async function assertAttachmentInOrg(propertyId: string | undefined, openingId: string | undefined, orgId: string): Promise<boolean> {
  if (propertyId && !(await assertPropertyInOrg(propertyId, orgId))) return false;
  if (openingId && !(await assertOpeningInOrg(openingId, orgId))) return false;
  return true;
}

const presignSchema = z.object({
  property_id: z.string().uuid().optional(),
  opening_id: z.string().uuid().optional(),
  content_type: z.string(),
}).refine((d) => d.property_id || d.opening_id, { message: "property_id or opening_id is required" });

// Step 1: same two-step presigned-upload pattern as photos — the client PUTs
// directly to storage, the API server never touches the file bytes.
documentsRouter.post("/presign", async (req: AuthedRequest, res) => {
  const parsed = presignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { property_id, opening_id, content_type } = parsed.data;
  const orgId = req.auth!.organizationId;

  if (!isAllowedDocumentContentType(content_type)) {
    return res.status(400).json({ error: "unsupported_content_type" });
  }

  try {
    if (!(await assertAttachmentInOrg(property_id, opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const attachedToId = opening_id || property_id!;
    const key = buildDocumentStorageKey(orgId, attachedToId, content_type);
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

const createDocumentSchema = z.object({
  property_id: z.string().uuid().optional(),
  opening_id: z.string().uuid().optional(),
  document_type: z.enum(["warranty", "service_contract", "insurance", "inspection_report", "other"]),
  title: z.string().min(1),
  storage_url: z.string().url(),
  file_size_bytes: z.number().optional(),
}).refine((d) => d.property_id || d.opening_id, { message: "property_id or opening_id is required" });

// Step 2: confirm the upload succeeded and record it. Same trust model as
// photos — the client's storage_url is trusted rather than re-verified
// against S3, fine at MVP scale, worth a HEAD-object check before real
// multi-tenant volume.
documentsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createDocumentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const userId = req.auth!.userId;

  try {
    if (!(await assertAttachmentInOrg(b.property_id, b.opening_id, orgId))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const result = await pool.query(
      `INSERT INTO documents (property_id, opening_id, document_type, title, storage_url, file_size_bytes, uploaded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.property_id ?? null, b.opening_id ?? null, b.document_type, b.title, b.storage_url, b.file_size_bytes ?? null, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

documentsRouter.get("/by-property/:propertyId", async (req: AuthedRequest, res) => {
  const { propertyId } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    if (!(await assertPropertyInOrg(propertyId, orgId))) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      "SELECT * FROM documents WHERE property_id = $1 ORDER BY created_at DESC",
      [propertyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

documentsRouter.get("/by-opening/:openingId", async (req: AuthedRequest, res) => {
  const { openingId } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    if (!(await assertOpeningInOrg(openingId, orgId))) return res.status(403).json({ error: "forbidden" });
    const result = await pool.query(
      "SELECT * FROM documents WHERE opening_id = $1 ORDER BY created_at DESC",
      [openingId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

documentsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const orgId = req.auth!.organizationId;
  try {
    const docResult = await pool.query(
      `SELECT * FROM documents
       WHERE id = $1
         AND (
           (property_id IS NOT NULL AND property_id IN (${propertiesForOrgSubquery(2)}))
           OR (opening_id IS NOT NULL AND opening_id IN (${openingsForOrgSubquery(2)}))
         )`,
      [id, orgId]
    );
    if (docResult.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const doc = docResult.rows[0];
    await pool.query("DELETE FROM documents WHERE id = $1", [id]);

    try {
      const url = new URL(doc.storage_url);
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
