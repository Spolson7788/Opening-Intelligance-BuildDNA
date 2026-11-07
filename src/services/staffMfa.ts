import { createHash, randomInt } from "node:crypto";
import { pool } from "../db/pool";
import { isMissingSchema } from "../middleware/auth";
import { rateLimitDecision } from "./staffMfaCrypto";
import { sendStaffSignInEmail } from "./passwordResetEmail";

export class StaffMfaError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  constructor(status: number, code: string, retryAfterSeconds?: number) {
    super(code);
    this.name = "StaffMfaError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const RESEND_COOLDOWN_MS = 60_000;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function newSignInCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
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
    throw error;
  } finally {
    client.release?.();
  }
}

export async function isActivePlatformStaff(userId: string): Promise<boolean> {
  try {
    const found = await pool.query("SELECT is_platform_staff($1) AS staff", [userId]);
    return found.rows[0]?.staff === true;
  } catch (error) {
    if (isMissingSchema(error)) return false;
    throw new StaffMfaError(503, "mfa_unavailable");
  }
}

async function failedAttempts(client: Db, userId: string): Promise<number> {
  const count = await client.query(
    `SELECT count(*)::int AS n FROM staff_mfa_attempts
     WHERE user_id = $1 AND succeeded = false AND kind IN ('totp', 'recovery', 'email')
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

async function recordAttempt(client: Db, userId: string, succeeded: boolean) {
  await client.query("INSERT INTO staff_mfa_attempts (user_id, succeeded, kind) VALUES ($1, $2, 'email')", [userId, succeeded]);
}

async function latestCodeAgeMs(userId: string): Promise<number | null> {
  const latest = await pool.query(
    "SELECT created_at FROM staff_sign_in_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (!latest.rows[0]) return null;
  return Date.now() - new Date(latest.rows[0].created_at).getTime();
}

/** Sends a new code and invalidates any unused one. The plaintext code is emailed and not stored or logged. */
export async function issueStaffSignInCode(userId: string, email: string): Promise<void> {
  const code = newSignInCode();
  const codeHash = hashCode(code);
  let storedId: string | undefined;
  await withTx(async (client) => {
    await client.query(
      "UPDATE staff_sign_in_codes SET invalidated_at = now() WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL",
      [userId]
    );
    const inserted = await client.query(
      "INSERT INTO staff_sign_in_codes (user_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes') RETURNING id",
      [userId, codeHash]
    );
    storedId = inserted.rows[0]?.id;
  });
  try {
    await sendStaffSignInEmail(email, code);
  } catch {
    if (storedId) {
      await pool.query("UPDATE staff_sign_in_codes SET invalidated_at = now() WHERE id = $1 AND used_at IS NULL", [storedId]).catch(() => undefined);
    }
    throw new StaffMfaError(503, "mfa_unavailable");
  }
}

export async function resendStaffSignInCode(userId: string, email: string): Promise<void> {
  const age = await latestCodeAgeMs(userId);
  if (age !== null && age < RESEND_COOLDOWN_MS) {
    throw new StaffMfaError(429, "resend_cooldown", Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - age) / 1000)));
  }
  await issueStaffSignInCode(userId, email);
}

export async function verifyStaffSignInCode(userId: string, code: string): Promise<void> {
  const denial = await withTx(async (client) => {
    if (rateLimitDecision(await failedAttempts(client, userId)) === "limited") throw new StaffMfaError(429, "mfa_rate_limited");
    const found = await client.query(
      `SELECT id, expires_at, used_at, invalidated_at FROM staff_sign_in_codes
       WHERE user_id = $1 AND code_hash = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId, hashCode(code.trim())]
    );
    const row = found.rows[0];
    if (!row) {
      await recordAttempt(client, userId, false);
      return new StaffMfaError(401, "invalid_mfa_code");
    }
    if (row.used_at || row.invalidated_at) {
      await recordAttempt(client, userId, false);
      return new StaffMfaError(401, "mfa_code_reused");
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await recordAttempt(client, userId, false);
      return new StaffMfaError(401, "mfa_code_expired");
    }
    const used = await client.query(
      "UPDATE staff_sign_in_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL AND invalidated_at IS NULL RETURNING id",
      [row.id]
    );
    if (!used.rows.length) {
      await recordAttempt(client, userId, false);
      return new StaffMfaError(401, "mfa_code_reused");
    }
    await recordAttempt(client, userId, true);
    return null;
  });
  if (denial) throw denial;
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
