import { Router } from "express";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole, AuthedRequest } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET as string;
const TOKEN_EXPIRY = "12h";

export function issueToken(user: { id: string; organization_id: string; role: string; session_version?: number; must_change_password?: boolean }) {
  // mustChangePassword is a UI hint only; requireAuth enforces the flag from the database.
  return jwt.sign(
    { userId: user.id, organizationId: user.organization_id, role: user.role, sessionVersion: user.session_version ?? 0, ...(user.must_change_password ? { mustChangePassword: true } : {}) },
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
  const reference = randomUUID();
  res.setHeader("X-OI-Login-Reference", reference);
  res.setHeader("Cache-Control", "no-store");
  // Server-only diagnostic categories. Never log inputs, hashes, tokens or
  // raw exceptions, and never disclose account existence to the client.
  const report = (outcome: string) => console.info("OI login", { reference, outcome });
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    report("invalid_request");
    return res.status(400).json({ error: "invalid_login_request", reference });
  }
  const { email, password } = parsed.data;
  try {
    const result = await pool.query(
      "SELECT id, organization_id, role, password_hash, is_active, session_version, (to_jsonb(users) ->> 'must_change_password')::boolean AS must_change_password FROM public.users WHERE email = $1",
      [email.toLowerCase()]
    );
    if (result.rows.length === 0) {
      report("account_not_found");
      return res.status(401).json({ error: "invalid_credentials", reference });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      report("password_mismatch");
      return res.status(401).json({ error: "invalid_credentials", reference });
    }
    if (!user.is_active) {
      report("account_deactivated");
      return res.status(403).json({ error: "account_deactivated", reference });
    }
    const token = issueToken(user);
    report("success");
    res.json({ token, expiresIn: TOKEN_EXPIRY, must_change_password: user.must_change_password === true });
  } catch {
    report("service_error");
    res.status(503).json({ error: "authentication_service_unavailable", reference });
  }
});

// List everyone in the caller's org — any authenticated user can see the
// team roster (needed for things like assigning a work order to a
// colleague), but nothing sensitive like password hashes ever leaves here.
authRouter.get("/users", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, role, is_active, created_at,
              (to_jsonb(users) ->> 'must_change_password')::boolean AS must_change_password,
              (to_jsonb(users) ->> 'is_test_account')::boolean AS is_test_account,
              (to_jsonb(users) ->> 'default_property_id') AS default_property_id FROM users
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

// M5: the signed-in user's own profile (allowed even while a password change is required).
authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const r = await pool.query(
      `SELECT id, organization_id, email, full_name, role, must_change_password, is_test_account, default_property_id, password_changed_at
       FROM users WHERE id = $1 AND organization_id = $2`,
      [req.auth!.userId, req.auth!.organizationId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json(r.rows[0]);
  } catch {
    res.status(503).json({ error: "authentication_service_unavailable" });
  }
});

const changePasswordSchema = z.object({ current_password: z.string().min(1).max(200), new_password: z.string() }).strict();

// M5: everyone can change their own password. Clears a forced change, records when it
// happened, signs out every other session (session_version bump) and returns a new token.
authRouter.post("/change-password", requireAuth, async (req: AuthedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_change_password_request" });
  const { current_password, new_password } = parsed.data;
  const bytes = Buffer.byteLength(new_password, "utf8");
  if (bytes < 12) return res.status(400).json({ error: "password_too_short" });
  if (bytes > 72) return res.status(400).json({ error: "password_too_long" });
  if (new_password === current_password) return res.status(400).json({ error: "password_unchanged" });
  try {
    const r = await pool.query("SELECT password_hash FROM users WHERE id = $1 AND organization_id = $2", [req.auth!.userId, req.auth!.organizationId]);
    if (!r.rows.length || !(await bcrypt.compare(current_password, r.rows[0].password_hash))) {
      return res.status(401).json({ error: "current_password_incorrect" });
    }
    const hash = await bcrypt.hash(new_password, 12);
    const u = await pool.query(
      `UPDATE users SET password_hash = $3, must_change_password = false, password_changed_at = now(), session_version = session_version + 1
       WHERE id = $1 AND organization_id = $2 RETURNING id, organization_id, role, session_version`,
      [req.auth!.userId, req.auth!.organizationId, hash]
    );
    await pool.query(
      `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code) VALUES ($1,$2,'Changed own password','POST','/api/auth/change-password',$3,200)`,
      [req.auth!.organizationId, req.auth!.userId, JSON.stringify({ current_password: "[redacted]", new_password: "[redacted]" })]
    );
    res.json({ token: issueToken(u.rows[0]), expiresIn: TOKEN_EXPIRY });
  } catch {
    res.status(503).json({ error: "authentication_service_unavailable" });
  }
});