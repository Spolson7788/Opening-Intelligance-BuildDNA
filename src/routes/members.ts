import { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool";
import { facilityAccessPredicate } from "../db/tenantScope";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { canCreateRole, INVITE_LIMITS, INVITE_TTL_DAYS, passwordProblem, ROLES } from "../services/memberRules";
import { emailSettings, getEmailProvider } from "../services/email";
import { acceptInviteUrl, inviteEmail } from "../services/inviteEmail";
import { issueToken } from "./auth";
import { membershipOf, activeAdminCount, record } from "../services/teamMemberships";

// M5: add team members directly (temporary password) or by email invite.
// Never logged, returned or stored in plain text: passwords and invite tokens.
export const membersRouter = Router();
export const invitesPublicRouter = Router();
membersRouter.use(requireAuth);

const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const PUBLIC_INVITE = "id, email, full_name, role, default_property_id, invited_by_user_id, expires_at, created_at, last_sent_at, email_status, accepted_at, revoked_at";

async function audit(client: any, orgId: string, userId: string, action: string, method: string, path: string, body: Record<string, unknown>, status: number) {
  await client.query(`INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, userId, action, method, path, JSON.stringify(body), status]);
}
function gate(req: AuthedRequest, role: string) { return canCreateRole(req.auth!.role, role); }
async function defaultPropertyOk(client: any, orgId: string, propertyId: string | null | undefined) {
  if (!propertyId) return true;
  const r = await client.query(`SELECT 1 FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id WHERE p.id=$2 AND ${facilityAccessPredicate(1)}`, [orgId, propertyId]);
  return r.rows.length > 0;
}

const base = {
  full_name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(ROLES),
  default_property_id: z.string().uuid().nullable().optional(),
};
const addSchema = z.object({ ...base, temporary_password: z.string(), is_test_account: z.boolean().default(false) }).strict();

// Direct add with a temporary password the admin types. The user must change it at first
// sign-in unless the admin ticked "Test account" (stored and audit-logged).
membersRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_member", fields: Object.keys(parsed.error.flatten().fieldErrors) });
  const b = parsed.data;
  const allowed = gate(req, b.role); if (!allowed.ok) return res.status(403).json({ error: allowed.error });
  const pw = passwordProblem(b.temporary_password); if (pw) return res.status(400).json({ error: pw });
  const orgId = req.auth!.organizationId, me = req.auth!.userId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await defaultPropertyOk(client, orgId, b.default_property_id))) { await client.query("ROLLBACK"); return res.status(400).json({ error: "default_property_not_accessible" }); }
    const open = await client.query("SELECT 1 FROM team_invites WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL", [orgId, b.email]);
    if (open.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "invite_pending" }); }
    const hash = await bcrypt.hash(b.temporary_password, 12);
    const mustChange = !b.is_test_account;
    const r = await client.query(`INSERT INTO users (organization_id, email, full_name, role, password_hash, must_change_password, is_test_account, default_property_id, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, email, full_name, role, is_active, must_change_password, is_test_account, default_property_id, created_at`,
      [orgId, b.email, b.full_name, b.role, hash, mustChange, b.is_test_account, b.default_property_id ?? null, me]);
    await audit(client, orgId, me, "Added team member", "POST", "/api/members", { user_id: r.rows[0].id, email: b.email, full_name: b.full_name, role: b.role,
      is_test_account: b.is_test_account, must_change_password: mustChange, default_property_id: b.default_property_id ?? null, temporary_password: "[redacted]" }, 201);
    await client.query("COMMIT");
    return res.status(201).json(r.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") return res.status(409).json({ error: "email_already_registered" });
    console.error("OI member add", { outcome: "error", code: String(err?.code ?? "unknown") });
    return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});

// ---- Email invites ----
const inviteSchema = z.object(base).strict();
async function rateLimited(client: any, orgId: string, inviteId: string | null) {
  const org = await client.query("SELECT count(*)::int AS n FROM team_invite_sends WHERE organization_id=$1 AND created_at > now() - interval '1 hour'", [orgId]);
  if (org.rows[0].n >= INVITE_LIMITS.orgSendsPerHour) return { error: "invite_rate_limited", scope: "organization", retry_after_seconds: 3600 };
  if (!inviteId) return null;
  const inv = await client.query(`SELECT count(*)::int AS n, max(created_at) AS last, EXTRACT(EPOCH FROM (now() - max(created_at)))::int AS age
    FROM team_invite_sends WHERE invite_id=$1 AND created_at > now() - interval '1 day'`, [inviteId]);
  const { n, age } = inv.rows[0];
  if (n > 0 && age !== null && age < INVITE_LIMITS.inviteCooldownSeconds) return { error: "invite_rate_limited", scope: "invite", retry_after_seconds: INVITE_LIMITS.inviteCooldownSeconds - age };
  if (n >= INVITE_LIMITS.inviteSendsPerDay) return { error: "invite_rate_limited", scope: "invite", retry_after_seconds: 86400 };
  return null;
}
// Rotates the token (only its hash is stored, so a resend must issue a new one), resets
// the expiry and tries to send. The token exists only in memory and in the email.
async function issueAndSend(client: any, req: AuthedRequest, invite: any) {
  const token = randomBytes(32).toString("base64url");
  const upd = await client.query(`UPDATE team_invites SET token_hash=$2, expires_at=now() + make_interval(days => $3), last_sent_at=now() WHERE id=$1 RETURNING ${PUBLIC_INVITE}`,
    [invite.id, hashToken(token), INVITE_TTL_DAYS]);
  const row = upd.rows[0];
  const settings = emailSettings();
  let outcome: "sent" | "not_configured" | "failed" = "not_configured";
  if (settings.configured || getEmailProvider().name !== "none") {
    const meta = (await client.query(`SELECT o.name AS org_name, u.full_name AS inviter FROM organizations o JOIN users u ON u.id=$2 WHERE o.id=$1`, [req.auth!.organizationId, req.auth!.userId])).rows[0];
    const url = acceptInviteUrl(settings.baseUrl ?? "http://localhost", token);
    const msg = inviteEmail({ to: row.email, inviteeName: row.full_name, inviterName: meta?.inviter ?? "Your administrator", organizationName: meta?.org_name ?? "your organization", role: row.role, acceptUrl: url, expiresAt: new Date(row.expires_at) });
    const r = await getEmailProvider().send({ to: row.email, ...msg });
    outcome = r.sent ? "sent" : r.reason === "email_not_configured" ? "not_configured" : "failed";
  }
  await client.query("UPDATE team_invites SET email_status=$2 WHERE id=$1", [row.id, outcome]);
  await client.query("INSERT INTO team_invite_sends (id, invite_id, organization_id, sent_by_user_id, outcome) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), row.id, req.auth!.organizationId, req.auth!.userId, outcome]);
  return { invite: { ...row, email_status: outcome }, email: { sent: outcome === "sent", status: outcome } };
}

membersRouter.get("/invites", async (req: AuthedRequest, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "admin_required" });
  const r = await pool.query(`SELECT ${PUBLIC_INVITE}, (expires_at <= now()) AS expired FROM team_invites WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC`, [req.auth!.organizationId]);
  res.json({ invites: r.rows, email_configured: emailSettings().configured || getEmailProvider().name !== "none" });
});

membersRouter.post("/invites", async (req: AuthedRequest, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_invite", fields: Object.keys(parsed.error.flatten().fieldErrors) });
  const b = parsed.data;
  const allowed = gate(req, b.role); if (!allowed.ok) return res.status(403).json({ error: allowed.error });
  const orgId = req.auth!.organizationId, me = req.auth!.userId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(64091, hashtext($1))", [orgId]);
    if (!(await defaultPropertyOk(client, orgId, b.default_property_id))) { await client.query("ROLLBACK"); return res.status(400).json({ error: "default_property_not_accessible" }); }
    if ((await client.query("SELECT 1 FROM users WHERE lower(email)=$1", [b.email])).rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "email_already_registered" }); }
    // An expired open invite for the same email is retired so a fresh one can be created.
    await client.query("UPDATE team_invites SET revoked_at=now(), revoked_by_user_id=$3 WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()", [orgId, b.email, me]);
    if ((await client.query("SELECT 1 FROM team_invites WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL", [orgId, b.email])).rows.length) {
      await client.query("ROLLBACK"); return res.status(409).json({ error: "invite_pending" });
    }
    const limited = await rateLimited(client, orgId, null); if (limited) { await client.query("ROLLBACK"); return res.status(429).json(limited); }
    const id = randomUUID();
    await client.query(`INSERT INTO team_invites (id, organization_id, email, full_name, role, default_property_id, invited_by_user_id, token_hash, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $9))`, [id, orgId, b.email, b.full_name, b.role, b.default_property_id ?? null, me, hashToken(randomBytes(32).toString("hex")), INVITE_TTL_DAYS]);
    const out = await issueAndSend(client, req, { id });
    await audit(client, orgId, me, "Created team invite", "POST", "/api/members/invites", { invite_id: id, email: b.email, full_name: b.full_name, role: b.role, default_property_id: b.default_property_id ?? null, email_status: out.invite.email_status }, 201);
    await client.query("COMMIT");
    return res.status(201).json(out);
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") return res.status(409).json({ error: "invite_pending" });
    console.error("OI invite create", { outcome: "error", code: String(err?.code ?? "unknown") });
    return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});

async function openInvite(client: any, req: AuthedRequest) {
  const r = await client.query(`SELECT * FROM team_invites WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [req.params.id, req.auth!.organizationId]);
  return r.rows[0];
}
membersRouter.post("/invites/:id/resend", async (req: AuthedRequest, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "admin_required" });
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "not_found" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inv = await openInvite(client, req);
    if (!inv) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    if (inv.accepted_at || inv.revoked_at) { await client.query("ROLLBACK"); return res.status(409).json({ error: "invite_closed" }); }
    const allowed = gate(req, inv.role); if (!allowed.ok) { await client.query("ROLLBACK"); return res.status(403).json({ error: allowed.error }); }
    const limited = await rateLimited(client, req.auth!.organizationId, inv.id); if (limited) { await client.query("ROLLBACK"); return res.status(429).json(limited); }
    const out = await issueAndSend(client, req, inv);
    await audit(client, req.auth!.organizationId, req.auth!.userId, "Resent team invite", "POST", `/api/members/invites/${inv.id}/resend`, { invite_id: inv.id, email: inv.email, email_status: out.invite.email_status }, 200);
    await client.query("COMMIT");
    return res.json(out);
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OI invite resend", { outcome: "error", code: String(err?.code ?? "unknown") });
    return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});
membersRouter.post("/invites/:id/revoke", async (req: AuthedRequest, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "admin_required" });
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "not_found" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inv = await openInvite(client, req);
    if (!inv) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    if (inv.accepted_at || inv.revoked_at) { await client.query("ROLLBACK"); return res.status(409).json({ error: "invite_closed" }); }
    const r = await client.query(`UPDATE team_invites SET revoked_at=now(), revoked_by_user_id=$2 WHERE id=$1 RETURNING ${PUBLIC_INVITE}`, [inv.id, req.auth!.userId]);
    await audit(client, req.auth!.organizationId, req.auth!.userId, "Revoked team invite", "POST", `/api/members/invites/${inv.id}/revoke`, { invite_id: inv.id, email: inv.email }, 200);
    await client.query("COMMIT");
    return res.json(r.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OI invite revoke", { outcome: "error", code: String(err?.code ?? "unknown") });
    return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});

// ---- Public: the invitee previews and accepts (token in the body, never in a URL) ----
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const INVALID = { error: "invite_invalid_or_expired" };
invitesPublicRouter.post("/preview", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const t = tokenSchema.safeParse(req.body?.token); if (!t.success) return res.status(410).json(INVALID);
  const r = await pool.query(`SELECT i.email, i.full_name, i.role, i.expires_at, o.name AS organization_name FROM team_invites i JOIN organizations o ON o.id=i.organization_id
    WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, [hashToken(t.data)]);
  if (!r.rows.length) return res.status(410).json(INVALID);
  return res.json(r.rows[0]);
});
const acceptSchema = z.object({ token: tokenSchema, password: z.string(), full_name: z.string().trim().min(1).max(200).optional() }).strict();
invitesPublicRouter.post("/accept", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = acceptSchema.safeParse(req.body); if (!parsed.success) return res.status(410).json(INVALID);
  const pw = passwordProblem(parsed.data.password); if (pw) return res.status(400).json({ error: pw });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inv = (await client.query(`SELECT * FROM team_invites WHERE token_hash=$1 FOR UPDATE`, [hashToken(parsed.data.token)])).rows[0];
    if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at).getTime() <= Date.now()) { await client.query("ROLLBACK"); return res.status(410).json(INVALID); }
    if ((await client.query("SELECT 1 FROM users WHERE lower(email)=$1", [inv.email])).rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "email_already_registered" }); }
    const hash = await bcrypt.hash(parsed.data.password, 12);
    const u = (await client.query(`INSERT INTO users (organization_id, email, full_name, role, password_hash, must_change_password, is_test_account, default_property_id, created_by_user_id, password_changed_at)
      VALUES ($1,$2,$3,$4,$5,false,false,$6,$7,now()) RETURNING id, organization_id, role, session_version`,
      [inv.organization_id, inv.email, parsed.data.full_name ?? inv.full_name, inv.role, hash, inv.default_property_id, inv.invited_by_user_id])).rows[0];
    await client.query("UPDATE team_invites SET accepted_at=now(), accepted_user_id=$2 WHERE id=$1", [inv.id, u.id]);
    await audit(client, inv.organization_id, u.id, "Accepted team invite", "POST", "/api/invites/accept", { invite_id: inv.id, email: inv.email, role: inv.role, password: "[redacted]" }, 201);
    await client.query("COMMIT");
    return res.status(201).json({ token: issueToken(u), expiresIn: "12h" });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") return res.status(409).json({ error: "email_already_registered" });
    console.error("OI invite accept", { outcome: "error", code: String(err?.code ?? "unknown") });
    return res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});
// Multi-company milestone 2: add an EXISTING person to the active company, or remove them from it.
// The target company is always the caller's active company (one stated location). Email domain
// never grants membership. The response never says whether an unknown email has an account elsewhere.
const membershipAddSchema = z.object({ email: base.email, role: z.enum(ROLES), reason: z.string().trim().min(1).max(500).optional() }).strict();
const membershipRemoveSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

membersRouter.post("/memberships", async (req: AuthedRequest, res) => {
  const parsed = membershipAddSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const g = gate(req, parsed.data.role);
  if (!g.ok) return res.status(403).json({ error: g.error });
  const orgId = req.auth!.organizationId, actor = req.auth!.userId;
  const reason = parsed.data.reason ?? "Added by company admin";
  let client;
  try { client = await pool.connect(); } catch { return res.status(503).json({ error: "database_unavailable" }); }
  try {
    await client.query("BEGIN");
    const u = (await client.query("SELECT id, is_active FROM users WHERE lower(email) = $1", [parsed.data.email])).rows[0];
    if (!u || !u.is_active) { await client.query("ROLLBACK"); return res.status(404).json({ error: "person_not_found_or_inactive" }); }
    const existing = await membershipOf(client, u.id, orgId, true);
    if (existing?.is_active) { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_member" }); }
    if (existing?.is_home) { await client.query("ROLLBACK"); return res.status(409).json({ error: "home_membership_use_reactivate" }); }
    await client.query(`INSERT INTO organization_memberships (user_id, organization_id, role, is_active, is_home, created_by_user_id)
      VALUES ($1,$2,$3,true,false,$4)
      ON CONFLICT (user_id, organization_id) DO UPDATE SET role=EXCLUDED.role, is_active=true, deactivated_at=NULL, deactivated_by_user_id=NULL, deactivation_reason=NULL`,
      [u.id, orgId, parsed.data.role, actor]);
    await client.query("UPDATE users SET session_version = session_version + 1 WHERE id=$1", [u.id]);
    const before = existing ? { organization_id: orgId, role: existing.role, is_active: false } : { organization_id: orgId, member: false };
    const after = { organization_id: orgId, role: parsed.data.role, is_active: true };
    if (existing) await record(client, { actor, orgId, target: u.id, change: "reactivate", action: "membership_added", reason, before, after, path: "/api/members/memberships", method: "POST" });
    else {
      await client.query(`INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
        VALUES ($1,$2,'membership_added',$2,$3,$4,$5,$6)`, [actor, orgId, u.id, reason, JSON.stringify(before), JSON.stringify(after)]);
      await audit(client, orgId, actor, "membership_added", "POST", "/api/members/memberships", { user_id: u.id, role: parsed.data.role, reason }, 201);
    }
    await client.query("COMMIT");
    res.status(201).json({ user_id: u.id, organization_id: orgId, role: parsed.data.role, is_active: true });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OI membership add", { outcome: "error", code: String(err?.code ?? "unknown") });
    res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});

membersRouter.delete("/memberships/:userId", async (req: AuthedRequest, res) => {
  const parsed = membershipRemoveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const orgId = req.auth!.organizationId, actor = req.auth!.userId, id = req.params.userId;
  if (!z.string().uuid().safeParse(id).success) return res.status(404).json({ error: "not_found" });
  if (id === actor) return res.status(400).json({ error: "cannot_modify_own_admin_status" });
  const reason = parsed.data.reason ?? "Removed by company admin";
  let client;
  try { client = await pool.connect(); } catch { return res.status(503).json({ error: "database_unavailable" }); }
  try {
    await client.query("BEGIN");
    const m = await membershipOf(client, id, orgId, true);
    if (!m || !m.is_active) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    if (m.is_home) { await client.query("ROLLBACK"); return res.status(409).json({ error: "home_membership_use_deactivate" }); }
    if (m.role === "admin" && (await activeAdminCount(client, orgId)) <= 1) { await client.query("ROLLBACK"); return res.status(400).json({ error: "cannot_remove_last_admin" }); }
    await client.query(`UPDATE organization_memberships SET is_active=false, deactivated_at=now(), deactivated_by_user_id=$3, deactivation_reason=$4
      WHERE user_id=$1 AND organization_id=$2`, [id, orgId, actor, reason]);
    await client.query("UPDATE users SET session_version = session_version + 1 WHERE id=$1", [id]);
    const before = { organization_id: orgId, role: m.role, is_active: true };
    await record(client, { actor, orgId, target: id, change: "deactivate", action: "membership_removed", reason, before, after: { ...before, is_active: false, scope: "this_company" }, path: "/api/members/memberships/" + id, method: "DELETE" });
    await client.query("COMMIT");
    res.json({ user_id: id, organization_id: orgId, is_active: false });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OI membership remove", { outcome: "error", code: String(err?.code ?? "unknown") });
    res.status(500).json({ error: "internal_error" });
  } finally { client.release(); }
});
