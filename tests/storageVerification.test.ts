import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checksumStreamWithinLimit } from "../src/services/storage";

async function* chunks(values: string[], observed: { count: number }) {
  for (const value of values) {
    observed.count += 1;
    yield Buffer.from(value);
  }
}

describe("bounded private-media verification", () => {
  it("verifies a streamed checksum without buffering the full object", async () => {
    const value = "bounded-stream";
    const expected = createHash("sha256").update(value).digest("hex");
    expect(await checksumStreamWithinLimit(chunks(["bounded", "-stream"], { count: 0 }), expected, 64)).toBe(true);
  });

  it("stops reading as soon as the server-side byte limit is exceeded", async () => {
    const observed = { count: 0 };
    const result = await checksumStreamWithinLimit(chunks(["1234", "5678", "never-read"], observed), "0".repeat(64), 6);
    expect(result).toBe(false);
    expect(observed.count).toBe(2);
  });
});
