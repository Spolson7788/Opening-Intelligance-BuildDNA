import { sha256Hex, MAX_PROVIDER_IMAGE_BYTES } from './recognitionRuns';
// Tracked downscale (hosting plan step 2): originals above the provider limit get a smaller copy made
// in memory for recognition ONLY. The stored original is never rewritten, re-uploaded or replaced.
// The run records the derived copy's sha256 next to the original's sha256, the target and the method.
export const DOWNSCALE_METHOD_VERSION = 'sharp-inside-noenlarge-v1';
export const DOWNSCALE_STEPS = [
  { max_dimension: 3072, quality: 85 },
  { max_dimension: 2048, quality: 80 },
  { max_dimension: 1600, quality: 75 },
] as const;
export const MAX_ORIGINAL_READ_BYTES = 50 * 1024 * 1024;

export type Downscale = {
  bytes: Uint8Array; sha256: string; width: number; height: number;
  target: { max_dimension: number; quality: number; format: string }; method_version: string;
};
export class DownscaleError extends Error {}

type SharpFactory = (input: Buffer) => any;
// Variable specifier keeps the native module out of the esbuild function bundle; if it is not
// deployed with the function the run fails explicitly ('downscale_unavailable'), never silently.
let loader: () => Promise<SharpFactory> = async () => {
  const name = 'sharp';
  const mod: any = await import(name);
  return (mod.default ?? mod) as SharpFactory;
};
export function setImageLibraryLoaderForTests(next: () => Promise<SharpFactory>) { loader = next; }

const FORMAT: Record<string, 'jpeg' | 'png' | 'webp'> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

export async function downscaleForRecognition(original: Uint8Array, contentType: string): Promise<Downscale> {
  const format = FORMAT[contentType];
  if (!format) throw new DownscaleError('downscale_unsupported_type');
  let sharp: SharpFactory;
  try { sharp = await loader(); } catch { throw new DownscaleError('downscale_unavailable'); }
  for (const step of DOWNSCALE_STEPS) {
    let out: { data: Buffer; info: { width: number; height: number } };
    try {
      let img = sharp(Buffer.from(original)).rotate()
        .resize({ width: step.max_dimension, height: step.max_dimension, fit: 'inside', withoutEnlargement: true });
      img = format === 'png' ? img.png({ compressionLevel: 9, quality: step.quality, palette: true })
        : format === 'webp' ? img.webp({ quality: step.quality }) : img.jpeg({ quality: step.quality, mozjpeg: true });
      out = await img.toBuffer({ resolveWithObject: true });
    } catch { throw new DownscaleError('downscale_failed'); }
    if (out.data.length <= MAX_PROVIDER_IMAGE_BYTES) {
      const bytes = new Uint8Array(out.data);
      return { bytes, sha256: sha256Hex(bytes), width: out.info.width, height: out.info.height,
        target: { max_dimension: step.max_dimension, quality: step.quality, format }, method_version: DOWNSCALE_METHOD_VERSION };
    }
  }
  throw new DownscaleError('downscale_could_not_fit_provider_limit');
}
