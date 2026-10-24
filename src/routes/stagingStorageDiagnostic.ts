// Temporary diagnostic: fail closed unless all exact staging restrictions hold.
import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const SITE = "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b";
const ORG = "66c07d0e-887d-4b78-a6bc-181b2a644c34";
const ENDPOINT = "https://boaoedvyvifppuklbwad.storage.supabase.co/storage/v1/s3";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/;
const HEX64 = /^[0-9a-f]{64}$(?![\s\S])/;

// Domain separation binds the operator's one-time comparison to this diagnostic run.
// Neither this digest nor a runtime digest is returned by the route.
export function storageIdentityProof(key: string, nonce: string, runId: string): Buffer {
  return createHmac("sha256", Buffer.from(nonce, "hex"))
    .update(JSON.stringify(["oi-storage-identity-v1", SITE, runId, key]), "utf8").digest();
}

export function stagingStorageDiagnosticRouter(
  platform: { siteId?: string; deployId?: string; context?: string },
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
) {
  const router = Router();
  // Immutable per-instance settings. Absolute expiry also bounds cold starts.
  const config: NodeJS.ProcessEnv = Object.fromEntries([
    "SITE_ID", "CONTEXT", "OI_STORAGE_DIAGNOSTIC_ENABLED", "OI_STORAGE_DIAGNOSTIC_START",
    "OI_STORAGE_DIAGNOSTIC_END", "OI_STORAGE_DIAGNOSTIC_RUN_ID", "OI_STORAGE_DIAGNOSTIC_ADMIN",
    "OI_STORAGE_DIAGNOSTIC_NONCE", "OI_STORAGE_DIAGNOSTIC_EXPECTED",
  ].map(key => [key, env[key]]));
  const start = Date.parse(config.OI_STORAGE_DIAGNOSTIC_START || "");
  const end = Date.parse(config.OI_STORAGE_DIAGNOSTIC_END || "");
  const runId = config.OI_STORAGE_DIAGNOSTIC_RUN_ID;
  const enabled = () => config.OI_STORAGE_DIAGNOSTIC_ENABLED === "true" &&
    platform.siteId === SITE && platform.context === 'production' && config.SITE_ID === SITE && config.CONTEXT === "production" &&
    Boolean(runId && UUID.test(runId) && platform.deployId && /^[0-9a-f]{24}$(?![\s\S])/.test(platform.deployId)) &&
    UUID.test(config.OI_STORAGE_DIAGNOSTIC_ADMIN || "") &&
    HEX64.test(config.OI_STORAGE_DIAGNOSTIC_NONCE || "") &&
    HEX64.test(config.OI_STORAGE_DIAGNOSTIC_EXPECTED || "") &&
    Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 15 * 60_000 &&
    now() >= start && now() < end;

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!enabled()) return res.sendStatus(404);
    next();
  });
  router.use(requireAuth); // Current database role, activity and session version.
  router.post("/", (req: AuthedRequest, res) => {
    if (!enabled()) return res.sendStatus(404); // Authentication may span expiry.
    if (req.auth?.role !== "admin" || req.auth.organizationId !== ORG ||
        req.auth.userId !== config.OI_STORAGE_DIAGNOSTIC_ADMIN) return res.sendStatus(404);
    // No caller-selected candidates: this cannot become a key-guessing oracle.
    if (Object.keys(req.query).length || (req.body && Object.keys(req.body).length)) {
      return res.status(400).json({ error: "empty_request_required" });
    }
    const access = env.S3_ACCESS_KEY_ID || "";
    const proof = storageIdentityProof(access, config.OI_STORAGE_DIAGNOSTIC_NONCE!, runId!);
    return res.json({
      accessKeyMatches: Boolean(access) && timingSafeEqual(proof, Buffer.from(config.OI_STORAGE_DIAGNOSTIC_EXPECTED!, "hex")),
      endpointMatches: env.S3_ENDPOINT === ENDPOINT,
      regionMatches: env.S3_REGION === "us-west-1",
      bucketMatches: env.S3_BUCKET === "oi-video-workflows-media",
      accessKeyPresent: Boolean(access),
      secretKeyPresent: Boolean(env.S3_SECRET_ACCESS_KEY),
    });
  });
  return router;
}
