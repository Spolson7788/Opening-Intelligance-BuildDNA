import { createHash } from 'node:crypto';
// Hosting plan step 1 (t130): recognition run records. Pure helpers, no I/O.

// The preserved engine (src/services/legacyVision.ts) is not modified. Its pinned source hash
// identifies the exact prompts; tests assert the model id and the engine still match these values.
export const LEGACY_VISION_ENGINE_CONFIG = {
  engine: 'legacyVision',
  model: 'claude-sonnet-4-5-20250929',
  prompt_version: 'legacyVision-source-sha256:9da330e98a2f1646',
} as const;
export const RECOGNITION_PREPROCESSING_VERSION = 'stored-original-none-v1'; // originals sent unmodified
// Provider limit for one image (Anthropic: 5 MB). Larger originals fail explicitly; downsizing is a
// later, versioned preprocessing step, never a silent client-side substitute.
export const MAX_PROVIDER_IMAGE_BYTES = 5 * 1024 * 1024;
export const IDENTITY_THRESHOLDS = { manufacturer: 0.5, series: 0.5, model: 0.6 } as const;

export function buildCommit(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OI_BUILD_COMMIT || env.COMMIT_REF || 'unknown';
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : 'unknown';
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type Identity = { level: 'none' | 'manufacturer' | 'series' | 'model'; manufacturer: string | null; series: string | null; model: string | null };

const text = (v: unknown) => (typeof v === 'string' && v.trim() && !['null', 'unknown'].includes(v.trim().toLowerCase()) ? v.trim().slice(0, 200) : null);
const conf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Conservative identity: report only the highest level that is supported, and never a level whose
 * parent level is missing. A level needs a value AND a confidence at or above its threshold.
 * Model additionally needs a transcribed marking and an evidence entry that supports "model".
 */
export function conservativeIdentity(result: any): Identity {
  const r = result && typeof result === 'object' ? result : {};
  const c = r.confidence && typeof r.confidence === 'object' ? r.confidence : {};
  const ok = (field: 'manufacturer' | 'series' | 'model') => text(r[field]) !== null && (conf(c[field]) ?? -1) >= IDENTITY_THRESHOLDS[field];
  const none: Identity = { level: 'none', manufacturer: null, series: null, model: null };
  if (!ok('manufacturer')) return none;
  const out: Identity = { level: 'manufacturer', manufacturer: text(r.manufacturer), series: null, model: null };
  if (!ok('series')) return out;
  out.level = 'series'; out.series = text(r.series);
  const marking = Array.isArray(r.visible_text) && r.visible_text.some((t: unknown) => typeof t === 'string' && t.trim());
  const modelEvidence = Array.isArray(r.evidence) && r.evidence.some((e: any) => e && String(e.supports).trim().toLowerCase() === 'model');
  if (!ok('model') || !marking || !modelEvidence) return out;
  out.level = 'model'; out.model = text(r.model);
  return out;
}
