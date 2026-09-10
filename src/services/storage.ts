import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

// Works with AWS S3 directly, or any S3-compatible endpoint (Supabase Storage,
// Cloudflare R2, MinIO for local dev) by setting S3_ENDPOINT. Keeping this
// generic avoids locking the MVP into one vendor before you've picked one.

const REQUIRED_ENV = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

function assertStorageConfigured() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Photo storage is not configured — missing env vars: ${missing.join(", ")}`);
  }
}

function getClient() {
  assertStorageConfigured();
  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined, // unset = real AWS S3
    forcePathStyle: !!process.env.S3_ENDPOINT, // needed for R2/MinIO/Supabase-style endpoints
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
    },
  });
}

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/heic",
  "video/mp4", "video/quicktime",
];

const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

// Videos from a phone camera can be large — this is a client-side-only
// backstop, not an enforced server-side limit. Presigned PUT URLs (unlike
// presigned POST) don't support a Content-Length-Range condition, so nothing
// here actually stops a much larger file from being uploaded; a determined
// or malicious client could bypass this. Worth revisiting (switch to
// presigned POST with policy conditions, or a server-side HEAD-object size
// check after upload) before this handles untrusted uploads at real scale.
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25MB — same client-side-only caveat as above

export function extensionForContentType(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  return map[contentType] || "bin";
}

export function mediaTypeForContentType(contentType: string): "photo" | "video" {
  return contentType.startsWith("video/") ? "video" : "photo";
}

export function isAllowedPhotoContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.includes(contentType);
}

export function isAllowedDocumentContentType(contentType: string): boolean {
  return ALLOWED_DOCUMENT_CONTENT_TYPES.includes(contentType);
}

// Generate a presigned PUT URL for direct client -> storage upload (never proxies
// the actual file bytes through our API server — keeps the 10mb JSON body limit
// irrelevant to photo size and avoids tying up the API on large uploads).
export async function getPresignedUploadUrl(key: string, contentType: string, expiresInSeconds = 300) {
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  return uploadUrl;
}

export function buildStorageKey(orgId: string, openingId: string, contentType: string): string {
  const ext = extensionForContentType(contentType);
  const uuid = randomUUID();
  return `org/${orgId}/opening/${openingId}/${uuid}.${ext}`;
}

// Documents can attach to a property alone (a property-wide insurance
// policy, say) with no specific opening involved, unlike photos which are
// always tied to one opening — so this takes whichever ID is actually
// relevant rather than assuming an opening exists.
export function buildDocumentStorageKey(orgId: string, attachedToId: string, contentType: string): string {
  const ext = extensionForContentType(contentType);
  const uuid = randomUUID();
  return `org/${orgId}/documents/${attachedToId}/${uuid}.${ext}`;
}

// The URL stored in the DB and served back to clients. If S3_PUBLIC_BASE_URL is
// set (e.g. a CDN domain or a public bucket URL), use it; otherwise fall back to
// constructing a standard virtual-hosted-style S3 URL.
export function buildPublicUrl(key: string): string {
  if (process.env.S3_PUBLIC_BASE_URL) {
    return `${process.env.S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
  }
  return `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
}

export async function deleteObject(key: string) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
}
