import { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole, AuthedRequest, isMissingSchema } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { membershipOf, activeAdminCount, record, HISTORY_DEFAULT_REASON } from "../services/teamMemberships";
import { passwordResetConfigured, sendPasswordChangedEmail, sendPasswordResetEmail } from "../services/passwordResetEmail";
import { isActivePlatformStaff, issueStaffSignInCode, resendStaffSignInCode, StaffMfaError, verifyStaffSignInCode } from "../services/staffMfa";

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET as string;
const TOKEN_EXPIRY = "12h";

export function issueToken(user: { id: string; organization_id: string; role: string; session_version?: number; must_change_password?: boolean; mfaVerified?: boolean; mfaPending?: boolean }) {
  // mustChangePassword is a UI hint only; requireAuth enforces the flag from the database.
  // Customer tokens omit both MFA claims. A pending staff token cannot also be verified.
  const pending = user.mfaPending === true && user.mfaVerified !== true;
  const verified = user.mfaVerified === true && !pending;
  return jwt.sign(
    {
      userId: user.id,
      organizationId: user.organization_id,
      role: user.role,
      sessionVersion: user.session_version ?? 0,
      ...(user.must_change_password ? { mustChangePassword: true } : {}),
      ...(verified ? { mfaVerified: true } : {}),
      ...(pending ? { mfaPending: true } : {}),
    },
    JWT_SECRET,
    { expiresIn: pending ? "10m" : TOKEN_EXPIRY }
  );
}


export type CompanyAccess = { organization_id: string; name: string | null; role: string; access: string; is_home: boolean; via_organization_id: string | null };

// Active memberships plus parent-tree access (admin: tree_admin; facilities_manager: tree_view, view-only).
// Databases without the memberships migration fall back to the legacy single company.
export async function loadCompanies(userId: string, homeOrgId: string, homeRole: string): Promise<CompanyAccess[]> {
  try {
    const r = await pool.query(
      `SELECT a.organization_id, o.name, a.role, a.access, a.via_organization_id, (a.organization_id = u.organization_id) AS is_home
       FROM users u CROSS JOIN LATERAL user_authorized_orgs(u.id) a LEFT JOIN organizations o ON o.id = a.organization_id
       WHERE u.id = $1 AND o.deactivated_at IS NULL ORDER BY (a.organization_id = u.organization_id) DESC, o.name`,
      [userId]
    );
    if (Array.isArray(r.rows) && r.rows.length && r.rows.every((x: any) => x && typeof x.access === "string")) return r.rows as CompanyAccess[];
    if (Array.isArray(r.rows) && r.rows.length === 0) return [];
  } catch { /* legacy schema */ }
  return [{ organization_id: homeOrgId, name: null, role: homeRole, access: "member", is_home: true, via_organization_id: homeOrgId }];
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
// C2 lock-down (Stephan, 2026-10-28): public self-signup is closed. OI staff create companies and
// their first admins; everyone else joins by invite. Only the vitest suites, which use this route as a
// fixture, can still reach the old handler below; hosted runtimes never set VITEST.
authRouter.post("/signup", (req, res, next) => {
  if (process.env.VITEST === "true") return next();
  res.setHeader("Cache-Control", "no-store");
  res.status(410).json({ error: "signup_closed", message: "Self-signup is closed. Ask your administrator for an invite." });
});
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
// RETIRED: accounts are added through POST /api/members (Add team member), which applies the
// forced first-sign-in password change and the role ceiling. Only the offline vitest suites, which use
// this route as a fixture, can still reach the old handler; hosted runtimes never set VITEST.
authRouter.post("/register", (req, res, next) => {
  if (process.env.VITEST === "true") return next();
  res.status(410).json({ error: "register_retired", message: "Use Add team member (POST /api/members)." });
});
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
      "SELECT id, organization_id, email, role, password_hash, is_active, session_version, (to_jsonb(users) ->> 'must_change_password')::boolean AS must_change_password FROM public.users WHERE email = $1",
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
    // Multi-company: list every company this person may act in; the home company is the default.
    const companies = await loadCompanies(user.id, user.organization_id, user.role);
    const active = companies.find((c) => c.is_home) ?? companies[0];
    if (!active) {
      const closed = await pool.query("SELECT deactivated_at IS NOT NULL AS closed FROM organizations WHERE id=$1", [user.organization_id]).catch((error) => {
        if ((error as { code?: string } | null)?.code === "42703") return { rows: [{ closed: false }] };
        throw error;
      });
      report(closed.rows[0]?.closed ? "company_deactivated" : "no_active_membership");
      return res.status(403).json({ error: closed.rows[0]?.closed ? "company_deactivated" : "membership_inactive", reference });
    }
    if (await isActivePlatformStaff(user.id)) {
      await issueStaffSignInCode(user.id, user.email);
      const mfaToken = issueToken({ ...user, organization_id: active.organization_id, role: active.role, mfaPending: true });
      report("mfa_required");
      return res.json({ mfa_required: true, mfa_token: mfaToken, expiresIn: "10m", resend_after_seconds: 60 });
    }
    const token = issueToken({ ...user, organization_id: active.organization_id, role: active.role });
    report("success");
    res.json({ token, expiresIn: TOKEN_EXPIRY, must_change_password: user.must_change_password === true,
      active_organization_id: active.organization_id, companies });
  } catch (error) {
    if (error instanceof StaffMfaError) {
      report("mfa_unavailable");
      return res.status(error.status).json({ error: error.code, reference });
    }
    report("service_error");
    res.status(503).json({ error: "authentication_service_unavailable", reference });
  }
});

const resetRequestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320) });
const resetSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: z.string().min(12).max(72),
});
const RESET_MESSAGE = { message: "If this account can receive email, a reset link is on its way." };

// The body cannot name an organization or a destination URL. The link is built only from server settings.
authRouter.post("/password-reset/request", async (req, res) => {
  const parsed = resetRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_email" });
  if (!passwordResetConfigured()) return res.status(503).json({ error: "password_reset_unavailable" });
  const started = Date.now();
  try {
    const client = await pool.connect();
    let delivery: { email: string; token: string; tokenHash: string } | undefined;
    try {
      await client.query("BEGIN");
      const userResult = await client.query(
        "SELECT id, email FROM users WHERE lower(email)=$1 AND is_active=true FOR UPDATE",
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
            "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1,$2,now()+interval '30 minutes')",
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
        await pool.query("UPDATE password_reset_tokens SET consumed_at=now() WHERE token_hash=$1", [delivery.tokenHash]);
        console.error("Password reset email delivery failed");
      }
    }
  } catch {
    console.error("Password reset request failed");
  }
  const remaining = 3200 - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return res.json(RESET_MESSAGE);
});

authRouter.post("/password-reset/confirm", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_reset_request" });
  if (Buffer.byteLength(parsed.data.password, "utf8") > 72) return res.status(400).json({ error: "invalid_reset_request" });
  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  let client;
  try { client = await pool.connect(); }
  catch { return res.status(503).json({ error: "password_reset_unavailable" }); }
  try {
    await client.query("BEGIN");
    const candidate = await client.query("SELECT user_id FROM password_reset_tokens WHERE token_hash=$1", [tokenHash]);
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
    await client.query("UPDATE users SET password_hash=$1, session_version=session_version+1 WHERE id=$2", [passwordHash, userId]);
    await client.query("UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [userId]);
    await client.query("COMMIT");
    try { await sendPasswordChangedEmail(email); }
    catch { console.error("Password changed email delivery failed"); }
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
  // People in the ACTIVE company (memberships), with their role there. Removed members of a
  // non-home company are not listed; deactivated people stay visible to their home company.
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, m.role, (m.is_active AND u.is_active) AS is_active, u.created_at, m.is_home,
              (to_jsonb(u) ->> 'must_change_password')::boolean AS must_change_password,
              (to_jsonb(u) ->> 'is_test_account')::boolean AS is_test_account,
              (to_jsonb(u) ->> 'default_property_id') AS default_property_id
       FROM organization_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND (m.is_active OR m.is_home) ORDER BY u.created_at`,
      [req.auth!.organizationId]
    ).catch(async (error) => {
      if (!isMissingSchema(error)) throw error;
      return pool.query(
        `SELECT id, email, full_name, role, is_active, created_at,
              (to_jsonb(users) ->> 'must_change_password')::boolean AS must_change_password,
              (to_jsonb(users) ->> 'is_test_account')::boolean AS is_test_account,
              (to_jsonb(users) ->> 'default_property_id') AS default_property_id FROM users
         WHERE organization_id = $1 ORDER BY created_at`, [req.auth!.organizationId]);
    });
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const updateUserSchema = z.object({
  role: z.enum(["admin", "facilities_manager", "technician", "inspector", "viewer"]).optional(),
  is_active: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

// Admin-only: change a team member's role, or deactivate/reactivate them.
// Two safeguards against an org accidentally locking itself out: an admin
// can't deactivate their own account, and the last active admin in an org
// can't be demoted or deactivated by anyone — both would leave the org with
// no one able to manage its team at all.
//
// Sessions: requireAuth (src/middleware/auth.ts) re-reads the user on every request, so a
// deactivated account is refused (403 account_deactivated) on its very next call. Any change to
// role or is_active made here also bumps session_version, so previously issued tokens are refused
// (401 session_revoked) and the person must sign in again. The field app wipes all on-device OI
// data when it receives either response.
authRouter.patch("/users/:id", requireAuth, requireRole("admin"), auditLog, async (req: AuthedRequest, res, next) => {
  // Multi-company: change the person's membership in the ACTIVE company only.
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data, orgId = req.auth!.organizationId, callerId = req.auth!.userId, id = req.params.id;
  if (b.role === undefined && b.is_active === undefined) return res.status(400).json({ error: "no_fields_to_update" });
  if (id === callerId && (b.is_active === false || (b.role !== undefined && b.role !== "admin"))) return res.status(400).json({ error: "cannot_modify_own_admin_status" });
  if (!z.string().uuid().safeParse(id).success) return res.status(404).json({ error: "not_found" });
  let client;
  try { client = await pool.connect(); } catch { return res.status(503).json({ error: "database_unavailable" }); }
  try {
    await client.query("BEGIN");
    const m = await membershipOf(client, id, orgId, true).catch(async (error) => { if (isMissingSchema(error)) throw Object.assign(new Error("legacy"), { legacy: true }); throw error; });
    if (!m || (!m.is_active && !m.is_home)) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    const nowActive = m.is_active && m.person_active;
    const demoting = b.role !== undefined && b.role !== "admin";
    if (m.role === "admin" && nowActive && (b.is_active === false || demoting) && (await activeAdminCount(client, orgId)) <= 1) {
      await client.query("ROLLBACK"); return res.status(400).json({ error: "cannot_remove_last_admin" });
    }
    const reason = b.reason ?? HISTORY_DEFAULT_REASON, path = "/api/auth/users/" + id;
    const before = { organization_id: orgId, role: m.role, is_active: nowActive, is_home: m.is_home };
    let role = m.role, active = nowActive, changed = false;
    if (b.role !== undefined && b.role !== m.role) {
      if (m.is_home) await client.query("UPDATE users SET role=$2 WHERE id=$1", [id, b.role]);
      else await client.query("UPDATE organization_memberships SET role=$3 WHERE user_id=$1 AND organization_id=$2", [id, orgId, b.role]);
      role = b.role; changed = true;
      await record(client, { actor: callerId, orgId, target: id, change: "role_change", action: "user_role_changed", reason, before, after: { ...before, role }, path, method: "PATCH" });
    }
    if (b.is_active !== undefined && b.is_active !== nowActive) {
      const snap = { ...before, role };
      if (m.is_home) {
        // Home company: deactivate the person everywhere / reactivate (home membership only).
        await client.query("UPDATE users SET is_active=$2 WHERE id=$1", [id, b.is_active]);
        await record(client, { actor: callerId, orgId, target: id, change: b.is_active ? "reactivate" : "deactivate", action: b.is_active ? "user_reactivated" : "user_deactivated",
          reason, before: snap, after: { ...snap, is_active: b.is_active, scope: b.is_active ? "home_membership_only" : "all_companies" }, path, method: "PATCH" });
      } else {
        await client.query(`UPDATE organization_memberships SET is_active=$3, deactivated_at=CASE WHEN $3 THEN NULL ELSE now() END,
          deactivated_by_user_id=CASE WHEN $3 THEN NULL ELSE $4::uuid END, deactivation_reason=CASE WHEN $3 THEN NULL ELSE $5 END
          WHERE user_id=$1 AND organization_id=$2`, [id, orgId, b.is_active, callerId, reason]);
        await record(client, { actor: callerId, orgId, target: id, change: b.is_active ? "reactivate" : "deactivate", action: b.is_active ? "membership_added" : "membership_removed",
          reason, before: snap, after: { ...snap, is_active: b.is_active, scope: "this_company" }, path, method: "PATCH" });
      }
      active = b.is_active; changed = true;
    }
    if (changed) await client.query("UPDATE users SET session_version = session_version + 1 WHERE id=$1", [id]);
    const u = (await client.query("SELECT id, email, full_name, created_at FROM users WHERE id=$1", [id])).rows[0];
    await client.query("COMMIT");
    res.json({ ...u, role, is_active: active, is_home: m.is_home });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.legacy) return next();
    console.error("OI team change", { outcome: "error", code: String(err?.code ?? "unknown") });
    res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});
// Legacy single-company path (databases without the memberships migration).
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
    // C2: a role or active-status change signs the person out everywhere (old tokens get 401 session_revoked).
    const roleChanged = b.role !== undefined && b.role !== target.role;
    const activeChanged = b.is_active !== undefined && b.is_active !== target.is_active;
    if (roleChanged || activeChanged) setClauses.push("session_version = session_version + 1");

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
       FROM users WHERE id = $1`,
      [req.auth!.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    // organization_id / role describe the ACTIVE company; home_organization_id is the person's home.
    res.json({ ...r.rows[0], home_organization_id: r.rows[0].organization_id, organization_id: req.auth!.organizationId,
      role: req.auth!.role, access: req.auth!.access ?? "member" });
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
    const r = await pool.query("SELECT password_hash FROM users WHERE id = $1 AND organization_id = $2", [req.auth!.userId, req.auth!.homeOrganizationId ?? req.auth!.organizationId]);
    if (!r.rows.length || !(await bcrypt.compare(current_password, r.rows[0].password_hash))) {
      return res.status(401).json({ error: "current_password_incorrect" });
    }
    const hash = await bcrypt.hash(new_password, 12);
    const u = await pool.query(
      `UPDATE users SET password_hash = $3, must_change_password = false, password_changed_at = now(), session_version = session_version + 1
       WHERE id = $1 AND organization_id = $2 RETURNING id, organization_id, role, session_version`,
      [req.auth!.userId, req.auth!.homeOrganizationId ?? req.auth!.organizationId, hash]
    );
    await pool.query("UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [req.auth!.userId]).catch((error) => {
      if (!isMissingSchema(error)) throw error;
    });
    await pool.query(
      `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code) VALUES ($1,$2,'Changed own password','POST','/api/auth/change-password',$3,200)`,
      [req.auth!.organizationId, req.auth!.userId, JSON.stringify({ current_password: "[redacted]", new_password: "[redacted]" })]
    );
    // Stay in the company the person was working in. A staff password change does not skip the authenticator.
    const staffNeedsCode = req.auth!.staff === true && req.auth!.mfaVerified !== true;
    const token = issueToken({
      ...u.rows[0],
      organization_id: req.auth!.organizationId,
      role: req.auth!.role,
      mfaVerified: req.auth!.mfaVerified === true,
      mfaPending: staffNeedsCode,
    });
    if (staffNeedsCode) return res.json({ token, expiresIn: "10m", mfa_required: true, resend_after_seconds: 60 });
    res.json({ token, expiresIn: TOKEN_EXPIRY });
  } catch {
    res.status(503).json({ error: "authentication_service_unavailable" });
  }
});
// Companies the signed-in person may switch to (fresh from the database).
authRouter.get("/companies", requireAuth, async (req: AuthedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const companies = await loadCompanies(req.auth!.userId, req.auth!.homeOrganizationId ?? req.auth!.organizationId, req.auth!.role);
    res.json({ active_organization_id: req.auth!.organizationId, companies });
  } catch {
    res.status(503).json({ error: "authentication_service_unavailable" });
  }
});

const switchSchema = z.object({ organization_id: z.string().uuid() });

// Switch the active company: re-checked against current memberships, then a new token is issued.
// Same response for "no such company" and "not yours", so company ids are not disclosed.
authRouter.post("/switch-company", requireAuth, async (req: AuthedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = switchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_switch_request" });
  try {
    const r = await pool.query(
      `SELECT u.id, u.session_version, (to_jsonb(u) ->> 'must_change_password')::boolean AS must_change_password, a.organization_id, a.role, a.access
       FROM users u JOIN LATERAL user_authorized_orgs(u.id) a ON a.organization_id = $2 WHERE u.id = $1 AND u.is_active`,
      [req.auth!.userId, parsed.data.organization_id]
    ).catch(async (error) => {
      if (!isMissingSchema(error)) throw error;
      // Before the memberships migration: only the person's own company exists.
      return pool.query(
        `SELECT id, session_version, (to_jsonb(users) ->> 'must_change_password')::boolean AS must_change_password, organization_id, role, 'member' AS access
         FROM users WHERE id = $1 AND organization_id = $2 AND is_active`, [req.auth!.userId, parsed.data.organization_id]);
    });
    const row = r.rows[0];
    if (!row) return res.status(403).json({ error: "membership_inactive" });
    const closed = await pool.query("SELECT deactivated_at IS NOT NULL AS closed FROM organizations WHERE id=$1", [row.organization_id]).catch((error) => {
      if ((error as { code?: string } | null)?.code === "42703") return { rows: [{ closed: false }] };
      throw error;
    });
    if (closed.rows[0]?.closed) return res.status(403).json({ error: "company_deactivated" });
    await pool.query(
      `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code) VALUES ($1,$2,'Switched company','POST','/api/auth/switch-company',$3,200)`,
      [row.organization_id, req.auth!.userId, JSON.stringify({ from_organization_id: req.auth!.organizationId, to_organization_id: row.organization_id })]
    ).catch(() => undefined);
    res.json({ token: issueToken({ id: row.id, organization_id: row.organization_id, role: row.role, session_version: row.session_version, must_change_password: row.must_change_password, mfaVerified: req.auth!.mfaVerified === true }),
      expiresIn: TOKEN_EXPIRY, active_organization_id: row.organization_id, role: row.role, access: row.access });
  } catch {
    res.status(503).json({ error: "authentication_service_unavailable" });
  }
});

function mfaError(res: { status: (code: number) => { json: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof StaffMfaError) {
    return res.status(error.status).json({ error: error.code, ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {}) });
  }
  const code = String((error as { code?: string } | null)?.code ?? "unknown");
  console.info("OI staff mfa", { outcome: "unavailable", code });
  return res.status(503).json({ error: "mfa_unavailable" });
}

const mfaBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

// Staff email-code step. The pending token can enter or resend a code, and nothing else.
authRouter.get("/mfa/status", requireAuth, async (req: AuthedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.auth?.staff !== true) return res.status(403).json({ error: "forbidden" });
  res.json({ staff: true, mfa_verified: req.auth.mfaVerified === true });
});

authRouter.post("/mfa/resend", requireAuth, async (req: AuthedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.auth?.staff !== true || req.auth.mfaVerified === true) return res.status(403).json({ error: "forbidden" });
  try {
    const user = await pool.query("SELECT email FROM users WHERE id = $1", [req.auth.userId]);
    const email = user.rows[0]?.email;
    if (!email) return res.status(503).json({ error: "mfa_unavailable" });
    await resendStaffSignInCode(req.auth.userId, email);
    console.info("OI staff mfa", { outcome: "code_resent" });
    res.json({ sent: true, resend_after_seconds: 60 });
  } catch (error) { mfaError(res, error); }
});

authRouter.post("/mfa/verify", requireAuth, async (req: AuthedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.auth?.staff !== true || req.auth.mfaVerified === true) return res.status(403).json({ error: "forbidden" });
  const parsed = mfaBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_mfa_code" });
  try {
    await verifyStaffSignInCode(req.auth.userId, parsed.data.code);
    const current = await pool.query(
      `SELECT id, session_version, (to_jsonb(users) ->> 'must_change_password')::boolean AS must_change_password
       FROM users WHERE id = $1`,
      [req.auth.userId]
    );
    const user = current.rows[0];
    if (!user) return res.status(503).json({ error: "mfa_unavailable" });
    const token = issueToken({
      id: user.id,
      organization_id: req.auth.organizationId,
      role: req.auth.role,
      session_version: user.session_version,
      must_change_password: user.must_change_password === true,
      mfaVerified: true,
    });
    const companies = await loadCompanies(req.auth.userId, req.auth.homeOrganizationId ?? req.auth.organizationId, req.auth.role);
    console.info("OI staff mfa", { outcome: "verified" });
    res.json({
      token,
      expiresIn: TOKEN_EXPIRY,
      must_change_password: user.must_change_password === true,
      active_organization_id: req.auth.organizationId,
      companies,
    });
  } catch (error) { mfaError(res, error); }
});
