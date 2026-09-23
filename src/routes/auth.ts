import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole, AuthedRequest } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { passwordResetConfigured, sendPasswordChangedEmail, sendPasswordResetEmail } from "../services/passwordResetEmail";

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET as string;
const TOKEN_EXPIRY = "12h";

function issueToken(user: { id: string; organization_id: string; role: string; session_version?: number }) {
  return jwt.sign(
    { userId: user.id, organizationId: user.organization_id, role: user.role, sessionVersion: user.session_version ?? 0 },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

const signupSchema = z.object({
  organization_name: z.string().min(1),
  org_type: z.enum(["customer", "service_partner", "internal"]).default("customer"),
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(1),
});

// Public self-serve entry point: creates a brand-new organization plus its
// first admin user, in one transaction, and logs them straight in. This is
// what replaces the "create an org via direct SQL" bootstrap step.
authRouter.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;

  let client;
  try {
    client = await pool.connect();
  } catch {
    // A failed connection has created no records. Do not leak connection
    // details or let Express 4 lose an asynchronous rejection.
    return res.status(503).json({ error: "database_unavailable" });
  }
  try {
    await client.query("BEGIN");

    const orgResult = await client.query(
      "INSERT INTO organizations (name, org_type) VALUES ($1, $2) RETURNING id",
      [b.organization_name, b.org_type]
    );
    const organizationId = orgResult.rows[0].id;

    const passwordHash = await bcrypt.hash(b.password, 12);
    const userResult = await client.query(
      `INSERT INTO users (organization_id, email, full_name, role, password_hash)
       VALUES ($1,$2,$3,'admin',$4)
       RETURNING id, organization_id, role`,
      [organizationId, b.email.toLowerCase(), b.full_name, passwordHash]
    );

    // Portfolios aren't a concept exposed in either frontend — properties
    // just need one to attach to — so create a default one here rather than
    // making a brand-new org figure out an extra manual setup step.
    await client.query(
      "INSERT INTO portfolios (organization_id, name) VALUES ($1, 'Main Portfolio')",
      [organizationId]
    );

    await client.query("COMMIT");

    const user = userResult.rows[0];
    const token = issueToken({ id: user.id, organization_id: user.organization_id, role: "admin" });
    res.status(201).json({ token, expiresIn: TOKEN_EXPIRY, organizationId });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "email_already_registered" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(1),
  role: z.enum(["admin", "facilities_manager", "technician", "inspector", "viewer"]),
});

// Invite a new user into the CALLER'S organization. Requires an authenticated
// admin — this used to accept an arbitrary organization_id in the request
// body with no proof of authorization, which meant anyone who guessed
// another customer's org UUID could add themselves as an admin to it. Fixed
// by deriving the org from the caller's own verified JWT instead of trusting
// client input.
authRouter.post("/register", requireAuth, requireRole("admin"), auditLog, async (req: AuthedRequest, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data;
  const organizationId = req.auth!.organizationId;

  try {
    const passwordHash = await bcrypt.hash(b.password, 12);
    const result = await pool.query(
      `INSERT INTO users (organization_id, email, full_name, role, password_hash)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, organization_id, email, full_name, role`,
      [organizationId, b.email.toLowerCase(), b.full_name, b.role, passwordHash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "email_already_registered" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password } = parsed.data;

  try {
    const result = await pool.query(
      "SELECT id, organization_id, role, password_hash, is_active, session_version FROM users WHERE email = $1",
      [email.toLowerCase()]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: "invalid_credentials" });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "invalid_credentials" });
    // Checked after the password, not before — an inactive account
    // shouldn't reveal it's a real (but disabled) email to someone probing
    // with a wrong password.
    if (!user.is_active) return res.status(403).json({ error: "account_deactivated" });

    const token = issueToken(user);
    res.json({ token, expiresIn: TOKEN_EXPIRY });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const resetRequestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320) });
const resetSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: z.string().min(12).max(128),
});
const RESET_MESSAGE = { message: "If this account can receive email, a reset link is on its way." };

authRouter.post("/password-reset/request", async (req, res) => {
  const parsed = resetRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_email" });
  // Never suggest that a message was sent when delivery is not configured.
  if (!passwordResetConfigured()) return res.status(503).json({ error: "password_reset_unavailable" });

  const started = Date.now();
  try {
    const client = await pool.connect();
    let delivery: { email: string; token: string; tokenHash: string } | undefined;
    try {
      await client.query("BEGIN");
      // Lock the account before counting. Concurrent requests cannot bypass the
      // per-account limit through multiple serverless instances.
      const userResult = await client.query(
        "SELECT id, email FROM users WHERE email=$1 AND is_active=true FOR UPDATE",
        [parsed.data.email]
      );
      if (userResult.rows.length) {
        const user = userResult.rows[0];
        const rate = await client.query(
          "SELECT count(*)::int AS sent FROM password_reset_tokens WHERE user_id=$1 AND created_at > now()-interval '1 hour'",
          [user.id]
        );
        if (rate.rows[0].sent < 3) {
          const token = randomBytes(32).toString("hex");
          const tokenHash = createHash("sha256").update(token).digest("hex");
          await client.query(
            "INSERT INTO password_reset_tokens (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '30 minutes')",
            [tokenHash, user.id]
          );
          delivery = { email: user.email, token, tokenHash };
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (delivery) {
      try {
        await sendPasswordResetEmail(delivery.email, delivery.token);
      } catch {
        // Keep the failed attempt for throttling, but make the unsent link unusable.
        await pool.query("UPDATE password_reset_tokens SET consumed_at=now() WHERE token_hash=$1", [delivery.tokenHash]);
        console.error("Password reset email delivery failed"); // no email, link, or token in logs
      }
    }
  } catch {
    console.error("Password reset request failed");
  }
  // Match the visible result for known, unknown, and rate-limited accounts.
  // The email provider has a 3-second deadline; keep the public response
  // timing similar whether the email exists or not.
  const remaining = 3200 - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return res.json(RESET_MESSAGE);
});

authRouter.post("/password-reset/confirm", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_reset_request" });
  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize simultaneous links for the same account before locking a token.
    const candidate = await client.query(
      "SELECT user_id FROM password_reset_tokens WHERE token_hash=$1",
      [tokenHash]
    );
    if (!candidate.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "invalid_or_expired_reset_link" });
    }
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [candidate.rows[0].user_id]);
    const result = await client.query(
      `SELECT t.user_id, u.email FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
       WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now() AND u.is_active=true FOR UPDATE OF t`,
      [tokenHash]
    );
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "invalid_or_expired_reset_link" });
    }
    const { user_id: userId, email } = result.rows[0];
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    await client.query(
      "UPDATE users SET password_hash=$1, session_version=session_version+1 WHERE id=$2",
      [passwordHash, userId]
    );
    await client.query(
      "UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL",
      [userId]
    );
    await client.query("COMMIT");
    try {
      await sendPasswordChangedEmail(email);
    } catch {
      console.error("Password changed email delivery failed");
    }
    return res.json({ message: "Password changed. Sign in with your new password." });
  } catch {
    await client.query("ROLLBACK");
    console.error("Password reset confirmation failed");
    return res.status(500).json({ error: "password_reset_failed" });
  } finally {
    client.release();
  }
});

// List everyone in the caller's org — any authenticated user can see the
// team roster (needed for things like assigning a work order to a
// colleague), but nothing sensitive like password hashes ever leaves here.
authRouter.get("/users", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, role, is_active, created_at FROM users
       WHERE organization_id = $1 ORDER BY created_at`,
      [req.auth!.organizationId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const updateUserSchema = z.object({
  role: z.enum(["admin", "facilities_manager", "technician", "inspector", "viewer"]).optional(),
  is_active: z.boolean().optional(),
});

// Admin-only: change a team member's role, or deactivate/reactivate them.
// Two safeguards against an org accidentally locking itself out: an admin
// can't deactivate their own account, and the last active admin in an org
// can't be demoted or deactivated by anyone — both would leave the org with
// no one able to manage its team at all.
//
// Known limitation, stated plainly: deactivation blocks new logins
// immediately, but an already-issued JWT (valid up to 12h, see TOKEN_EXPIRY)
// isn't re-checked against the database on every request, so a just-
// deactivated user's existing session keeps working until it naturally
// expires. Fixing that fully means a DB lookup on every authenticated
// request — a real performance tradeoff, not something to silently take on
// without deciding it's worth it.
authRouter.patch("/users/:id", requireAuth, requireRole("admin"), auditLog, async (req: AuthedRequest, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { id } = req.params;
  const b = parsed.data;
  const orgId = req.auth!.organizationId;
  const callerId = req.auth!.userId;

  const isDeactivating = b.is_active === false;
  const isDemoting = b.role !== undefined && b.role !== "admin";

  if (id === callerId && (isDeactivating || isDemoting)) {
    return res.status(400).json({ error: "cannot_modify_own_admin_status" });
  }

  try {
    const targetResult = await pool.query(
      "SELECT role, is_active FROM users WHERE id = $1 AND organization_id = $2",
      [id, orgId]
    );
    if (targetResult.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const target = targetResult.rows[0];

    if (target.role === "admin" && target.is_active && (isDeactivating || isDemoting)) {
      const adminCountResult = await pool.query(
        "SELECT COUNT(*)::int AS count FROM users WHERE organization_id = $1 AND role = 'admin' AND is_active = true",
        [orgId]
      );
      if (adminCountResult.rows[0].count <= 1) {
        return res.status(400).json({ error: "cannot_remove_last_admin" });
      }
    }

    const setClauses: string[] = [];
    const values: any[] = [];
    if (b.role !== undefined) { values.push(b.role); setClauses.push(`role = $${values.length}`); }
    if (b.is_active !== undefined) { values.push(b.is_active); setClauses.push(`is_active = $${values.length}`); }
    if (setClauses.length === 0) return res.status(400).json({ error: "no_fields_to_update" });

    values.push(id, orgId);
    const result = await pool.query(
      `UPDATE users SET ${setClauses.join(", ")} WHERE id = $${values.length - 1} AND organization_id = $${values.length}
       RETURNING id, email, full_name, role, is_active, created_at`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
