import { emailSettings, sendEmail, type EmailAttachment } from "./email";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const MAX_FILES = 5;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function attachmentByteLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PURCHASING_EMAIL_MAX_ATTACHMENT_BYTES);
  if (Number.isFinite(raw) && raw >= 1024 && raw <= 40 * 1024 * 1024) return raw;
  return 8 * 1024 * 1024;
}

export interface PurchasingUpload {
  filename: string;
  content_base64: string;
}

export interface PurchasingSendInput {
  openingId: string;
  hardwareComponentId: string;
  organizationId: string;
  userId: string;
  note?: string;
  documentIds: string[];
  referenceSha256s: string[];
  includeApproved: boolean;
  uploads: PurchasingUpload[];
}

export type SheetFile = { bytes: Buffer; contentType: "application/pdf" | "image/jpeg" | "image/png"; extension: "pdf" | "jpg" | "png" };

// iOS Files often delivers a PDF with an empty type and a name that has no
// extension. The bytes decide what it is, not the picker label.
export function decodePurchasingSheet(base64: string, maxBytes = MAX_UPLOAD_BYTES): SheetFile | null {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 8 || bytes.length > maxBytes) return null;
    if (bytes.subarray(0, 4).toString() === "%PDF") return { bytes, contentType: "application/pdf", extension: "pdf" };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, contentType: "image/jpeg", extension: "jpg" };
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, contentType: "image/png", extension: "png" };
    return null;
  } catch {
    return null;
  }
}

export function purchasingFilename(name: string, extension: SheetFile["extension"]): string {
  const base = name.replace(/\.[^./\\]+$/, "").replace(/[^\w.\- ]+/g, "_").trim().slice(0, 80) || "sheet";
  return `${base}.${extension}`;
}

export async function resolvePurchasingEmail(db: Queryable, organizationId: string, userId: string): Promise<string | null> {
  const row = await db.query(
    `SELECT o.purchasing_email AS org_email, b.purchasing_email AS branch_email
     FROM organizations o
     LEFT JOIN user_branch_assignments a ON a.user_id=$2 AND a.organization_id=o.id
     LEFT JOIN company_branches b ON b.id=a.branch_id AND b.organization_id=o.id AND b.is_active=true
     WHERE o.id=$1`,
    [organizationId, userId],
  );
  const branch = row.rows[0]?.branch_email as string | null;
  const org = row.rows[0]?.org_email as string | null;
  return branch || org || null;
}

export async function sendPurchasingPackage(db: Queryable, input: PurchasingSendInput): Promise<{ error?: string; status?: number; send?: any }> {
  if (input.documentIds.length + input.referenceSha256s.length + input.uploads.length + (input.includeApproved ? 1 : 0) === 0) {
    return { error: "document_required", status: 400 };
  }
  if (input.uploads.length > MAX_FILES) return { error: "too_many_files", status: 400 };
  const to = await resolvePurchasingEmail(db, input.organizationId, input.userId);
  if (!to) return { error: "purchasing_email_missing", status: 409 };

  const files: Array<{ filename: string; bytes: Buffer | null; link: string | null; documentId: string | null; contentType: string }> = [];
  if (input.documentIds.length) {
    const docs = await db.query(
      `SELECT id, title, storage_url FROM documents WHERE id = ANY($1::uuid[]) AND opening_id=$2`,
      [input.documentIds, input.openingId],
    );
    if (docs.rows.length !== input.documentIds.length) return { error: "document_not_on_opening", status: 400 };
    for (const doc of docs.rows) {
      const link = typeof doc.storage_url === "string" && doc.storage_url.startsWith("https://") ? doc.storage_url : null;
      files.push({ filename: `${doc.title}.pdf`, bytes: null, link, documentId: doc.id, contentType: "application/pdf" });
    }
  }
  if (input.referenceSha256s.length) {
    const refs = await db.query(
      `SELECT sha256, title FROM reference_documents WHERE sha256 = ANY($1::text[]) AND status='approved'`,
      [input.referenceSha256s],
    );
    if (refs.rows.length !== input.referenceSha256s.length) return { error: "reference_not_approved", status: 400 };
    for (const ref of refs.rows) files.push({ filename: `${ref.title}.pdf`, bytes: null, link: null, documentId: null, contentType: "application/pdf" });
  }
  if (input.includeApproved) {
    const approval = await db.query(
      `SELECT document_url FROM component_purchasing_approvals
       WHERE component_id=$1 AND revoked_at IS NULL`,
      [input.hardwareComponentId],
    );
    if (!approval.rows.length) return { error: "approved_document_missing", status: 400 };
    const url = approval.rows[0].document_url as string;
    files.push({ filename: "approved-document.pdf", bytes: null, link: url.startsWith("https://") ? url : null, documentId: null, contentType: "application/pdf" });
  }
  for (const upload of input.uploads) {
    const sheet = decodePurchasingSheet(upload.content_base64);
    if (!sheet) return { error: "sheet_unreadable", status: 400 };
    files.push({ filename: purchasingFilename(upload.filename, sheet.extension), bytes: sheet.bytes, link: null, documentId: null, contentType: sheet.contentType });
  }

  const limit = attachmentByteLimit();
  const uploadBytes = files.reduce((sum, file) => sum + (file.bytes?.length ?? 0), 0);
  const uploadsFit = uploadBytes > 0 && uploadBytes <= limit;
  const deliveryMode = files.every((file) => file.bytes) && uploadsFit ? "attachments" : "links";

  const inserted = await db.query(
    `INSERT INTO purchasing_sends
      (organization_id, opening_id, hardware_component_id, sent_by_user_id, sent_to, note, delivery_mode, document_ids, reference_sha256s)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.organizationId, input.openingId, input.hardwareComponentId, input.userId, to, input.note ?? null, deliveryMode, input.documentIds, input.referenceSha256s],
  );
  const send = inserted.rows[0];
  const base = emailSettings().baseUrl || "";
  const attachments: EmailAttachment[] = [];
  const links: string[] = [];
  for (const file of files) {
    const fileId = crypto.randomUUID();
    const secureLink = file.bytes ? `${base}/api/purchasing/sends/${send.id}/files/${fileId}` : file.link;
    await db.query(
      `INSERT INTO purchasing_send_files (id, send_id, filename, content_type, byte_size, content, link_url, source_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [fileId, send.id, file.filename, file.contentType, file.bytes?.length ?? 0, file.bytes, file.bytes && !uploadsFit ? secureLink : file.link, file.documentId],
    );
    if (file.bytes && uploadsFit) attachments.push({ filename: file.filename, contentBase64: file.bytes.toString("base64") });
    if (!(file.bytes && uploadsFit)) links.push(`${file.filename}: ${secureLink || "on file in Opening Intelligence"}`);
  }

  const subject = "Cut sheets for purchasing";
  const text = [
    "A technician sent hardware documents for purchasing.",
    input.note ? `Note: ${input.note}` : "",
    attachments.length ? "Files that fit are attached." : "",
    links.length ? "These files are linked instead of attached:" : "",
    ...links,
  ].filter(Boolean).join("\n");
  const outcome = await sendEmail({
    to,
    subject,
    text,
    html: `<p>${text.replace(/\n/g, "<br>")}</p>`,
    attachments: attachments.length ? attachments : undefined,
  });
  if (!outcome.sent) {
    try {
      await db.query("DELETE FROM purchasing_send_files WHERE send_id=$1", [send.id]);
      await db.query("DELETE FROM purchasing_sends WHERE id=$1", [send.id]);
    } catch (error) {
      console.error("OI purchasing", { outcome: "cleanup_failed", code: error instanceof Error && "code" in error ? String((error as { code?: string }).code || "") : "" });
    }
    return { error: outcome.reason, status: 503 };
  }
  return { send };
}

