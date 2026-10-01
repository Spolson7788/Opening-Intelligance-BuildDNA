import { MAX_IMAGE_BYTES } from "./mediaLimits";

// Phone cameras routinely produce 3–8 MB photographs, above the API's 2 MB
// field-photo limit. Before a photograph is queued, an oversized image is
// re-encoded as a JPEG copy that fits the limit (largest size first, never
// enlarged). When the device cannot decode the format (for example HEIC in a
// Chromium browser) or no copy fits, the original is returned unchanged with
// withinLimit=false so the caller can keep it on the device for review
// instead of discarding it or queueing an upload the server will refuse.

export interface PreparedImage {
  blob: Blob;
  contentType: string;
  reduced: boolean;
  withinLimit: boolean;
  sourceBytes: number;
  width?: number;
  height?: number;
  reason?: "decode_failed" | "cannot_reduce_below_limit";
}

export interface DecodedImage {
  width: number;
  height: number;
  encode(longEdge: number, quality: number): Promise<{ blob: Blob; width: number; height: number }>;
  close(): void;
}

export type ImageDecoder = (blob: Blob) => Promise<DecodedImage>;

export const REDUCTION_LADDER: ReadonlyArray<{ longEdge: number; quality: number }> = [
  { longEdge: 4032, quality: 0.85 },
  { longEdge: 3072, quality: 0.85 },
  { longEdge: 2560, quality: 0.82 },
  { longEdge: 2560, quality: 0.7 },
  { longEdge: 2048, quality: 0.75 },
  { longEdge: 1600, quality: 0.72 },
  { longEdge: 1280, quality: 0.7 },
];

export async function prepareImageForUpload(
  file: Blob,
  limit = MAX_IMAGE_BYTES,
  decode: ImageDecoder = decodeWithCanvas,
): Promise<PreparedImage> {
  const sourceBytes = file.size;
  if (sourceBytes <= limit) {
    return { blob: file, contentType: file.type, reduced: false, withinLimit: true, sourceBytes };
  }
  let decoded: DecodedImage;
  try {
    decoded = await decode(file);
  } catch {
    return { blob: file, contentType: file.type, reduced: false, withinLimit: false, sourceBytes, reason: "decode_failed" };
  }
  try {
    const longest = Math.max(decoded.width, decoded.height);
    const tried = new Set<string>();
    for (const step of REDUCTION_LADDER) {
      const edge = Math.min(step.longEdge, longest); // never enlarge
      const key = `${edge}:${step.quality}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const out = await decoded.encode(edge, step.quality);
      if (out.blob.size > 0 && out.blob.size <= limit) {
        return { blob: out.blob, contentType: "image/jpeg", reduced: true, withinLimit: true, sourceBytes,
          width: out.width, height: out.height };
      }
    }
    return { blob: file, contentType: file.type, reduced: false, withinLimit: false, sourceBytes,
      reason: "cannot_reduce_below_limit" };
  } catch {
    return { blob: file, contentType: file.type, reduced: false, withinLimit: false, sourceBytes, reason: "decode_failed" };
  } finally {
    decoded.close();
  }
}

export function reducedFilename(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "") || "photograph";
  return `${base}.jpg`;
}

async function decodeWithCanvas(blob: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
  return {
    width: bitmap.width,
    height: bitmap.height,
    async encode(longEdge: number, quality: number) {
      const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas_unavailable");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality }), width, height };
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas_unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const out = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("encode_failed"))), "image/jpeg", quality));
      return { blob: out, width, height };
    },
    close() { bitmap.close(); },
  };
}
