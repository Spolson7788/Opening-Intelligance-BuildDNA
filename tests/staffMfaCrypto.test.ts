import { describe, expect, it } from "vitest";
import {
  authenticatorSetupUrl,
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  matchTotp,
  MfaKeyError,
  rateLimitDecision,
  totpAt,
} from "../src/services/staffMfaCrypto";

const SHA1_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("staff authenticator crypto", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(SHA1_SECRET, Math.floor(seconds / 30))).toBe(code);
      expect(totpAt(SHA1_SECRET, seconds * 1000).code).toBe(code);
    }
  });

  it("rejects a replay of the same time step and accepts the next one", () => {
    const secret = Buffer.from("replay-secret-value!!");
    const now = 1_700_000_000_000;
    const first = totpAt(secret, now);
    expect(matchTotp(secret, first.code, now, null)).toEqual({ ok: true, step: first.step });
    expect(matchTotp(secret, first.code, now, first.step).ok).toBe(false);
    expect(matchTotp(secret, first.code, now, first.step)).toMatchObject({ reason: "replay" });
    const next = totpAt(secret, now + 30_000);
    expect(next.step).toBe(first.step + 1);
    expect(matchTotp(secret, next.code, now + 30_000, first.step)).toEqual({ ok: true, step: next.step });
  });

  it("rejects a wrong code", () => {
    const result = matchTotp(SHA1_SECRET, "000000", 59_000, null);
    if (totpAt(SHA1_SECRET, 59_000).code === "000000") {
      expect(result.ok).toBe(true);
    } else {
      expect(result).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("encrypts the secret so the stored value is not the secret", () => {
    process.env.STAFF_MFA_ENCRYPTION_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
    const plain = Buffer.from("totp-secret-bytes!!");
    const stored = encryptSecret(plain);
    expect(stored.ciphertext.equals(plain)).toBe(false);
    expect(decryptSecret(stored.ciphertext, stored.iv, stored.tag).equals(plain)).toBe(true);
    const tampered = Buffer.from(stored.tag);
    tampered[0] ^= 1;
    expect(() => decryptSecret(stored.ciphertext, stored.iv, tampered)).toThrow();
  });

  it("refuses a missing encryption key", () => {
    const previous = process.env.STAFF_MFA_ENCRYPTION_KEY;
    delete process.env.STAFF_MFA_ENCRYPTION_KEY;
    expect(() => encryptSecret(Buffer.from("x"))).toThrow(MfaKeyError);
    process.env.STAFF_MFA_ENCRYPTION_KEY = previous;
  });

  it("hashes recovery codes once and normalizes dashes and case", () => {
    const [first, second] = generateRecoveryCodes(2);
    expect(generateRecoveryCodes()).toHaveLength(10);
    expect(first).not.toBe(second);
    expect(hashRecoveryCode(first)).toBe(hashRecoveryCode(first.toLowerCase()));
    expect(hashRecoveryCode(first)).toBe(hashRecoveryCode(first.replace("-", "")));
    expect(hashRecoveryCode(first)).not.toBe(first);
    expect(hashRecoveryCode(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("limits code attempts after five failures", () => {
    expect(rateLimitDecision(4)).toBe("ok");
    expect(rateLimitDecision(5)).toBe("limited");
  });

  it("builds an otpauth link the iPhone Passwords app can open", () => {
    const url = authenticatorSetupUrl("staff@example.invalid", "SECRETKEY");
    expect(url.startsWith("otpauth://totp/Opening%20Intelligence:staff%40example.invalid?")).toBe(true);
    expect(url).toContain("secret=SECRETKEY");
    expect(url).toContain("issuer=Opening%20Intelligence");
    expect(url).toContain("algorithm=SHA1");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
    expect(url.split("?")[0]).not.toContain("%3A");
  });

  it("round-trips base32", () => {
    const raw = Buffer.from([0, 1, 2, 250, 255, 16, 32, 64, 128, 200]);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
  });
});
