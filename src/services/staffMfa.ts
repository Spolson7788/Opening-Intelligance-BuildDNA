import QRCode from "qrcode";
import { pool } from "../db/pool";
import { isMissingSchema } from "../middleware/auth";
import {
  asBuffer,
  authenticatorSetupUrl,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchTotp,
  MfaKeyError,
  randomBytesSecret,
  rateLimitDecision,
  RECOVERY_CODE_COUNT,
} from "./staffMfaCrypto";

export class StaffMfaError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = "StaffMfaError";
    this.status = status;
    this.code = code;
  }
}

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const SHOWN_ONCE = "This setup QR code and these recovery codes are shown only once. Save the recovery codes somewhere safe. Each code works a single time.";

function unavailable(error: unknown): StaffMfaError {
  if (error instanceof StaffMfaError) return error;
  if (error instanceof MfaKeyError) return new StaffMfaError(503, "mfa_unavailable");
  return new StaffMfaError(503, "mfa_unavailable");
}

async function withTx<T>(fn: (client: Db) => Promise<T>): Promise<T> {
  let client: Db & { release?: () => void };
  try {
    client = await pool.connect();
  } catch {
    throw new StaffMfaError(503, "mfa_unavailable");
  }
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error instanceof StaffMfaError || error instanceof MfaKeyError ? unavailable(error) : error;
  } finally {
    client.release?.();
  }
}

/** Customer, or a staff member who still needs to enroll or enter a code. Missing MFA tables fail closed for staff. */
export async function staffLoginGate(userId: string): Promise<"customer" | "enrolled" | "enrollment_required"> {
  let staff = false;
  try {
    const found = await pool.query("SELECT is_platform_staff($1) AS staff", [userId]);
    staff = found.rows[0]?.staff === true;
  } catch (error) {
    if (isMissingSchema(error)) return "customer";
    throw new StaffMfaError(503, "mfa_unavailable");
  }
  if (!staff) return "customer";
  try {
    const factor = await pool.query("SELECT confirmed_at IS NOT NULL AS confirmed FROM staff_mfa_factors WHERE user_id = $1", [userId]);
    return factor.rows[0]?.confirmed === true ? "enrolled" : "enrollment_required";
  } catch (error) {
    if (isMissingSchema(error)) throw new StaffMfaError(503, "mfa_unavailable");
    throw new StaffMfaError(503, "mfa_unavailable");
  }
}

async function failedAttempts(client: Db, userId: string): Promise<number> {
  const count = await client.query(
    `SELECT count(*)::int AS n FROM staff_mfa_attempts
     WHERE user_id = $1 AND succeeded = false AND kind IN ('totp', 'recovery')
       AND attempted_at > now() - interval '15 minutes'
       AND attempted_at > COALESCE(
         (SELECT max(attempted_at) FROM staff_mfa_attempts WHERE user_id = $1 AND kind = 'lockout_cleared'),
         '-infinity'::timestamptz)`,
    [userId]
  );
  return Number(count.rows[0]?.n ?? 0);
}

async function clearCodeLockout(client: Db, userId: string) {
  await client.query(
    "INSERT INTO staff_mfa_attempts (user_id, succeeded, kind) VALUES ($1, true, 'lockout_cleared')",
    [userId]
  );
}

async function recordAttempt(client: Db, userId: string, succeeded: boolean, kind: "totp" | "recovery") {
  await client.query("INSERT INTO staff_mfa_attempts (user_id, succeeded, kind) VALUES ($1, $2, $3)", [userId, succeeded, kind]);
}

export async function enrollStaffFactor(userId: string, email: string) {
  const raw = randomBytesSecret();
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const stored = encryptSecret(raw);
  await withTx(async (client) => {
    const existing = await client.query("SELECT confirmed_at FROM staff_mfa_factors WHERE user_id = $1 FOR UPDATE", [userId]);
    if (existing.rows[0]?.confirmed_at) throw new StaffMfaError(409, "already_enrolled");
    const saved = await client.query(
      `INSERT INTO staff_mfa_factors (user_id, secret_ciphertext, secret_iv, secret_tag)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, secret_iv = EXCLUDED.secret_iv,
         secret_tag = EXCLUDED.secret_tag, confirmed_at = NULL, last_accepted_step = NULL, updated_at = now()
       WHERE staff_mfa_factors.confirmed_at IS NULL
       RETURNING user_id`,
      [userId, stored.ciphertext, stored.iv, stored.tag]
    );
    if (!saved.rows.length) throw new StaffMfaError(409, "already_enrolled");
    await client.query("DELETE FROM staff_mfa_recovery_codes WHERE user_id = $1", [userId]);
    for (const code of codes) {
      await client.query("INSERT INTO staff_mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, hashRecoveryCode(code)]);
    }
  });
  const secret = base32Encode(raw);
  const otpauthUrl = authenticatorSetupUrl(email, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 1, width: 256 });
  return { otpauth_url: otpauthUrl, secret, qr_data_url: qrDataUrl, recovery_codes: codes, warning: SHOWN_ONCE };
}

export async function verifyStaffFactor(userId: string, input: { code?: string; recoveryCode?: string }) {
  const code = input.code?.trim();
  const recoveryCode = input.recoveryCode?.trim();
  if (!!code === !!recoveryCode) throw new StaffMfaError(400, "invalid_mfa_code");
  // Expected denials are committed (so the rate-limit row stays) and thrown after the transaction.
  const denial = await withTx(async (client) => {
    const factor = await client.query(
      "SELECT secret_ciphertext, secret_iv, secret_tag, confirmed_at, last_accepted_step FROM staff_mfa_factors WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    const row = factor.rows[0];
    if (!row) throw new StaffMfaError(400, "enrollment_required");
    if (rateLimitDecision(await failedAttempts(client, userId)) === "limited") throw new StaffMfaError(429, "mfa_rate_limited");
    if (recoveryCode) {
      if (!row.confirmed_at) throw new StaffMfaError(400, "enrollment_required");
      const hashed = hashRecoveryCode(recoveryCode);
      const found = await client.query(
        "SELECT id, used_at FROM staff_mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 FOR UPDATE",
        [userId, hashed]
      );
      const match = found.rows[0];
      if (!match) {
        await recordAttempt(client, userId, false, "recovery");
        return new StaffMfaError(401, "invalid_mfa_code");
      }
      if (match.used_at) {
        await recordAttempt(client, userId, false, "recovery");
        return new StaffMfaError(401, "mfa_code_reused");
      }
      const used = await client.query(
        "UPDATE staff_mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
        [match.id]
      );
      if (!used.rows.length) return new StaffMfaError(401, "mfa_code_reused");
      await recordAttempt(client, userId, true, "recovery");
      return null;
    }
    let secret: Buffer;
    try {
      secret = decryptSecret(asBuffer(row.secret_ciphertext), asBuffer(row.secret_iv), asBuffer(row.secret_tag));
    } catch {
      throw new StaffMfaError(503, "mfa_unavailable");
    }
    const last = row.last_accepted_step == null ? null : Number(row.last_accepted_step);
    const matched = matchTotp(secret, code!, Date.now(), last != null && Number.isFinite(last) ? last : null);
    if (!matched.ok) {
      await recordAttempt(client, userId, false, "totp");
      return new StaffMfaError(401, matched.reason === "replay" ? "mfa_code_reused" : "invalid_mfa_code");
    }
    const saved = await client.query(
      `UPDATE staff_mfa_factors SET last_accepted_step = $2, confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
       WHERE user_id = $1 AND (last_accepted_step IS NULL OR last_accepted_step < $2) RETURNING user_id`,
      [userId, matched.step]
    );
    if (!saved.rows.length) {
      await recordAttempt(client, userId, false, "totp");
      return new StaffMfaError(401, "mfa_code_reused");
    }
    await recordAttempt(client, userId, true, "totp");
    return null;
  });
  if (denial) throw denial;
}

export async function resetStaffMfa(input: { actorId: string; actorOrgId: string; targetId: string; reason: string }) {
  if (input.actorId === input.targetId) throw new StaffMfaError(400, "cannot_reset_own_mfa");
  await withTx(async (client) => {
    const actor = await client.query("SELECT is_platform_staff($1) AS staff", [input.actorId]);
    if (actor.rows[0]?.staff !== true) throw new StaffMfaError(403, "forbidden");
    const target = await client.query("SELECT is_platform_staff($1) AS staff", [input.targetId]);
    if (target.rows[0]?.staff !== true) throw new StaffMfaError(404, "not_staff");
    const had = await client.query("SELECT confirmed_at IS NOT NULL AS enrolled FROM staff_mfa_factors WHERE user_id = $1 FOR UPDATE", [input.targetId]);
    const enrolled = had.rows[0]?.enrolled === true;
    await client.query("DELETE FROM staff_mfa_recovery_codes WHERE user_id = $1", [input.targetId]);
    await client.query("DELETE FROM staff_mfa_factors WHERE user_id = $1", [input.targetId]);
    await clearCodeLockout(client, input.targetId);
    await client.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [input.targetId]);
    const detail = { target_user_id: input.targetId, reason: input.reason };
    await client.query(
      `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code)
       VALUES ($1, $2, 'Reset staff authenticator', 'POST', $3, $4, 200)`,
      [input.actorOrgId, input.actorId, "/api/platform/staff/" + input.targetId + "/mfa-reset", JSON.stringify(detail)]
    );
    await client.query(
      `INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
       VALUES ($1, $2, 'staff_mfa_reset', $2, $3, $4, $5, $6)`,
      [input.actorId, input.actorOrgId, input.targetId, input.reason, JSON.stringify({ enrolled }), JSON.stringify({ enrolled: false, lockout_cleared: true })]
    );
  });
}

export async function unlockStaffMfa(input: { actorId: string; actorOrgId: string; targetId: string; reason: string }) {
  if (input.actorId === input.targetId) throw new StaffMfaError(400, "cannot_unlock_own_mfa");
  await withTx(async (client) => {
    const actor = await client.query("SELECT is_platform_staff($1) AS staff", [input.actorId]);
    if (actor.rows[0]?.staff !== true) throw new StaffMfaError(403, "forbidden");
    const target = await client.query("SELECT is_platform_staff($1) AS staff", [input.targetId]);
    if (target.rows[0]?.staff !== true) throw new StaffMfaError(404, "not_staff");
    await clearCodeLockout(client, input.targetId);
    const detail = { target_user_id: input.targetId, reason: input.reason };
    await client.query(
      `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code)
       VALUES ($1, $2, 'Cleared staff code lockout', 'POST', $3, $4, 200)`,
      [input.actorOrgId, input.actorId, "/api/platform/staff/" + input.targetId + "/mfa-unlock", JSON.stringify(detail)]
    );
    await client.query(
      `INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
       VALUES ($1, $2, 'staff_mfa_lockout_cleared', $2, $3, $4, $5, $6)`,
      [input.actorId, input.actorOrgId, input.targetId, input.reason, JSON.stringify({ locked: true }), JSON.stringify({ locked: false })]
    );
  });
}
