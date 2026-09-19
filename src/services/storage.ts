import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";

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

// Reservation rejects declared oversize media, and confirmation independently
// enforces the stored object size before any photo is accepted. Retrieval also
// stops at the same bound while hashing, so a malicious oversized object is
// never read fully into process memory.
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25MB — same client-side-only caveat as above

export function maximumMediaBytes(contentType: string): number {
  return contentType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

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

export async function getPresignedPrivatePhotoUploadUrl(input: {
  key: string;
  contentType: string;
  byteSize: number;
  sha256Checksum: string;
  photoId: string;
}, expiresInSeconds = 300) {
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.byteSize,
    Metadata: {
      "oi-sha256": input.sha256Checksum,
      "oi-photo-id": input.photoId,
    },
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

export async function getPresignedPrivatePhotoReadUrl(key: string, expiresInSeconds = 300) {
  const client = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

export interface StoredPhotoMetadata {
  byteSize: number;
  contentType: string;
  sha256Checksum?: string;
  photoId?: string;
}

export async function headPrivatePhoto(key: string): Promise<StoredPhotoMetadata> {
  const client = getClient();
  const result = await client.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  return {
    byteSize: result.ContentLength ?? -1,
    contentType: result.ContentType ?? "",
    sha256Checksum: result.Metadata?.["oi-sha256"],
    photoId: result.Metadata?.["oi-photo-id"],
  };
}

export async function verifyPrivatePhotoRetrieval(
  key: string,
  expectedSha256: string,
  maximumBytes: number,
) {
  const client = getClient();
  const result = await client.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  if (!result.Body) return false;
  return checksumStreamWithinLimit(
    result.Body as AsyncIterable<Uint8Array>, expectedSha256, maximumBytes,
  );
}

export async function checksumStreamWithinLimit(
  body: AsyncIterable<Uint8Array>,
  expectedSha256: string,
  maximumBytes: number,
) {
  const hash = createHash("sha256");
  let bytesRead = 0;
  for await (const chunk of body) {
    bytesRead += chunk.byteLength;
    if (bytesRead > maximumBytes) return false;
    hash.update(chunk);
  }
  const actual = hash.digest("hex");
  return actual === expectedSha256;
}

export function verifyStoredPhoto(
  expected: { byteSize: number; contentType: string; sha256Checksum: string; photoId: string },
  actual: StoredPhotoMetadata,
): string[] {
  const failures: string[] = [];
  if (actual.byteSize !== expected.byteSize) failures.push("byte_size_mismatch");
  if (actual.contentType !== expected.contentType) failures.push("content_type_mismatch");
  if (actual.sha256Checksum !== expected.sha256Checksum) failures.push("checksum_mismatch");
  if (actual.photoId !== expected.photoId) failures.push("photo_id_mismatch");
  return failures;
}

export function buildStorageKey(orgId: string, openingId: string, contentType: string, objectId: string = randomUUID()): string {
  const ext = extensionForContentType(contentType);
  return `org/${orgId}/opening/${openingId}/${objectId}.${ext}`;
}

export function isStorageKeyInOpeningScope(key: string, orgId: string, openingId: string): boolean {
  return key.startsWith(`org/${orgId}/opening/${openingId}/`) && !key.includes("..");
}

export function buildPrivatePhotoStorageKey(
  orgId: string,
  openingId: string,
  photoId: string,
  contentType: string,
): string {
  const ext = extensionForContentType(contentType);
  return `private/org/${orgId}/opening/${openingId}/photo/${photoId}.${ext}`;
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
