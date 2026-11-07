import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;
export const RECOVERY_CODE_COUNT = 10;
export const MFA_FAILURE_LIMIT = 5;

export class MfaKeyError extends Error {
  constructor() {
    super("mfa_unavailable");
    this.name = "MfaKeyError";
  }
}

/** 32-byte key from STAFF_MFA_ENCRYPTION_KEY (standard base64). Read at call time. */
export function staffMfaEncryptionKey(): Buffer {
  const raw = process.env.STAFF_MFA_ENCRYPTION_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new MfaKeyError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new MfaKeyError();
  return key;
}

export function randomBytesSecret(): Buffer {
  return randomBytes(20);
}

export function encryptSecret(plain: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", staffMfaEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptSecret(ciphertext: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", staffMfaEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Buffer {
  const alphabet = new Map([...BASE32].map((char, index) => [char, index]));
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.toUpperCase().replace(/=+$/g, "")) {
    const next = alphabet.get(char);
    if (next === undefined) throw new Error("invalid_base32");
    value = (value << 5) | next;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP, SHA-1, 6 digits. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(TOTP_DIGITS, "0");
}

export function totpAt(secret: Buffer, timeMs: number): { code: string; step: number } {
  const step = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
  return { code: hotp(secret, step), step };
}

export function totpCodeForBase32(secret: string, timeMs = Date.now()): string {
  return totpAt(base32Decode(secret), timeMs).code;
}

export type TotpMatch = { ok: true; step: number } | { ok: false; reason: "invalid" | "replay" };

/** Accept the current 30-second step and one step of clock skew. The same step cannot be used twice. */
export function matchTotp(secret: Buffer, code: string, timeMs: number, lastAcceptedStep: number | null): TotpMatch {
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };
  const step = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
  const presented = Buffer.from(code);
  for (const delta of [0, -1, 1]) {
    const candidate = step + delta;
    if (candidate < 0) continue;
    const expected = Buffer.from(hotp(secret, candidate));
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      if (lastAcceptedStep !== null && candidate <= lastAcceptedStep) return { ok: false, reason: "replay" };
      return { ok: true, step: candidate };
    }
  }
  return { ok: false, reason: "invalid" };
}

function recoveryChar(): string {
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  for (;;) {
    const byte = randomBytes(1)[0];
    if (byte < limit) return RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  }
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let body = "";
    for (let i = 0; i < 10; i++) body += recoveryChar();
    return `${body.slice(0, 5)}-${body.slice(5)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

export function rateLimitDecision(failedAttempts: number, limit = MFA_FAILURE_LIMIT): "ok" | "limited" {
  return failedAttempts >= limit ? "limited" : "ok";
}

export function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  throw new MfaKeyError();
}
