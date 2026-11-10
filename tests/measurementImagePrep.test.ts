import { expect, it } from "vitest";
import { MEASUREMENT_READER_MAX_BYTES, prepareMeasurementImage } from "../field-app/src/lib/photoPreparation";
import type { DecodedImage } from "../field-app/src/lib/photoPreparation";

function blob(size: number, type: string) {
  return new Blob([new Uint8Array(size)], { type });
}

function decoder(width: number, height: number, bytesPerPixel: number): (file: Blob) => Promise<DecodedImage> {
  return async () => ({
    width,
    height,
    async encode(longEdge: number, quality: number) {
      const scale = Math.min(1, longEdge / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      return { blob: blob(Math.max(1, Math.round(w * h * bytesPerPixel * quality)), "image/jpeg"), width: w, height: h };
    },
    close() {},
  });
}

it("keeps a small jpeg and turns HEIC or a large screenshot into a jpeg under the reader limit", async () => {
  let decoded = false;
  const small = blob(80_000, "image/jpeg");
  const kept = await prepareMeasurementImage(small, async () => { decoded = true; throw new Error("unused"); });
  expect(decoded).toBe(false);
  expect(kept.contentType).toBe("image/jpeg");
  expect(kept.blob).toBe(small);

  const heic = await prepareMeasurementImage(blob(2_000_000, "image/heic"), decoder(1206, 2622, 0.2));
  expect(heic.contentType).toBe("image/jpeg");
  expect(heic.blob.size).toBeLessThanOrEqual(MEASUREMENT_READER_MAX_BYTES);

  const large = await prepareMeasurementImage(blob(MEASUREMENT_READER_MAX_BYTES + 1, "image/jpeg"), decoder(4032, 3024, 0.15));
  expect(large.contentType).toBe("image/jpeg");
  expect(large.blob.size).toBeLessThanOrEqual(MEASUREMENT_READER_MAX_BYTES);
  await expect(prepareMeasurementImage(blob(100, "image/heic"), async () => { throw new Error("unsupported"); })).rejects.toThrow("measurement_image_unreadable");
});
