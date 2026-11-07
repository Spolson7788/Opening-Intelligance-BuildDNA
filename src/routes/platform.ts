import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { recognitionUsageReport } from "../services/recognitionUsageReport";
import { resetStaffMfa, StaffMfaError } from "../services/staffMfa";
import { recognitionRunRecordsMonthly, reprocessRecordOutbox, recordOutboxStatus } from "../services/recognitionRunRecords";

// OI staff read access (multi-company design, part B): READ ONLY overviews by facility and by
// service-provider company. Staff status is re-checked in the database on every request
// (is_platform_staff: active platform_staff row + active account + active internal membership).
// Nothing here writes, and no other company's users can reach it.
export const platformRouter = Router();

platformRouter.use(requireAuth, async (req: AuthedRequest, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const r = await pool.query("SELECT is_platform_staff($1) AS staff", [req.auth!.userId]);
    // Customers stay forbidden. Staff without a verified authenticator session get no staff powers.
    if (r.rows[0]?.staff !== true) return res.status(403).json({ error: "forbidden" });
    if (req.auth?.mfaVerified !== true) return res.status(403).json({ error: "mfa_required" });
    return next();
  } catch {
    return res.status(503).json({ error: "authorization_service_unavailable" });
  }
});

// M5: every staff read is recorded (after the staff check passed).
platformRouter.use(async (req: AuthedRequest, _res, next) => {
  if (req.method === "GET" && req.path !== "/me") await auditRead(req, req.path, req.query && Object.keys(req.query).length ? { query: req.query } : {});
  next();
});

platformRouter.get("/facilities", async (_req, res) => {
  try {
    const r = await pool.query(`SELECT property_id, property_name, state, owner_organization_id, owner_name, top_organization_id,
      active_provider_ids, building_count::int, opening_count::int FROM platform_facility_overview ORDER BY owner_name, property_name LIMIT 1000`);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

// Recognition usage by company and month (staff only, read-only; behind the staff check above).
platformRouter.get("/recognition-usage", async (req, res) => {
  const month = typeof req.query.month === "string" && req.query.month ? req.query.month : new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: "invalid_month" });
  try { res.json(await recognitionUsageReport(month)); }
  catch { res.status(503).json({ error: "recognition_usage_unavailable" }); }
});

// Recognition run records by company and month (Oct 31 milestone; staff only, read-only). Optional
// month=YYYY-MM; without it every month. Read through RLS as the acting staff user.
platformRouter.get("/recognition-run-records/monthly", async (req: AuthedRequest, res) => {
  const month = typeof req.query.month === "string" && req.query.month ? req.query.month : undefined;
  if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: "invalid_month" });
  try { res.json({ month: month ?? null, rows: await recognitionRunRecordsMonthly(req.auth!.userId, month) }); }
  catch { res.status(503).json({ error: "recognition_run_records_unavailable" }); }
});

// Record outbox: record writes that failed after retries. Staff can see how many are pending and
// reprocess them (idempotent; entries are kept and marked processed, never deleted).
platformRouter.get("/recognition-run-records/outbox", async (_req, res) => {
  try { res.json(await recordOutboxStatus()); } catch { res.status(503).json({ error: "recognition_run_records_unavailable" }); }
});
platformRouter.post("/recognition-run-records/outbox/reprocess", async (req: AuthedRequest, res) => {
  const raw = req.body?.limit, limit = raw === undefined ? 100 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({ error: "invalid_limit" });
  try { res.json(await reprocessRecordOutbox(limit)); } catch { res.status(503).json({ error: "recognition_run_records_unavailable" }); }
});

// OI-staff edit of price, recognition cost and safety caps (12:23). Validated here and again in the
// SECURITY DEFINER functions, which re-check OI staff and write the audit row (old/new + reason).
const usageSettingsSchema = z.object({
  opening_price_cents_per_month: z.number().int().min(0).max(100000).optional(),
  cost_per_photo_usd: z.number().min(0).max(100).multipleOf(0.000001).nullable().optional(),
  default_monthly_photo_cap: z.number().int().min(1).max(10000000).optional(),
  cap_warning_ratio: z.number().min(0.05).max(1).multipleOf(0.001).optional(),
  reason: z.string().trim().min(1).max(500),
}).strict().refine((b) => Object.keys(b).some((k) => k !== "reason"), { message: "nothing_to_change" });
const safetyCapSchema = z.object({ monthly_photo_cap: z.number().int().min(1).max(10000000).nullable(), reason: z.string().trim().min(1).max(500) }).strict();

platformRouter.get("/recognition-usage/settings", async (req, res) => {
  try {
    const s = (await pool.query(`SELECT opening_price_cents_per_month, cost_per_photo_usd, default_monthly_photo_cap, cap_warning_ratio, updated_at, updated_reason
      FROM recognition_usage_settings WHERE id`)).rows[0] ?? null;
    const caps = (await pool.query(`SELECT c.organization_id, o.name AS organization_name, c.monthly_photo_cap, c.set_reason, c.updated_at
      FROM recognition_safety_caps c JOIN organizations o ON o.id = c.organization_id ORDER BY o.name LIMIT 1000`)).rows;
    await auditRead(req as AuthedRequest, "platform_recognition_usage_settings_read");
    res.json({ settings: s && { ...s, cost_per_photo_usd: s.cost_per_photo_usd == null ? null : Number(s.cost_per_photo_usd), cap_warning_ratio: Number(s.cap_warning_ratio) }, caps });
  } catch { res.status(503).json({ error: "recognition_usage_unavailable" }); }
});

platformRouter.put("/recognition-usage/settings", async (req, res) => {
  const p = usageSettingsSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "invalid_usage_settings" });
  const r = req as AuthedRequest; const b = p.data;
  try {
    const out = await tx(res, async (c) => (await c.query(`SELECT recognition_usage_settings_update($1::uuid,$2::uuid,$3::text,$4::int,$5::numeric,$6::boolean,$7::int,$8::numeric) AS v`,
      [r.auth!.userId, r.auth!.organizationId, b.reason, b.opening_price_cents_per_month ?? null, b.cost_per_photo_usd ?? null,
       b.cost_per_photo_usd !== undefined, b.default_monthly_photo_cap ?? null, b.cap_warning_ratio ?? null])).rows[0].v);
    if (out !== undefined) res.json({ settings: out });
  } catch (err) { fail(res, err, "usage_settings_update_failed"); }
});

platformRouter.put("/recognition-usage/caps/:orgId", async (req, res) => {
  const id = uuid.safeParse(req.params.orgId); const p = safetyCapSchema.safeParse(req.body);
  if (!id.success || !p.success) return res.status(400).json({ error: "invalid_safety_cap" });
  const r = req as AuthedRequest;
  try {
    const out = await tx(res, async (c) => (await c.query(`SELECT recognition_safety_cap_set($1::uuid,$2::uuid,$3::uuid,$4::int,$5::text) AS v`,
      [r.auth!.userId, r.auth!.organizationId, id.data, p.data.monthly_photo_cap, p.data.reason])).rows[0].v);
    if (out !== undefined) res.json({ cap: out });
  } catch (err) { fail(res, err, "safety_cap_update_failed"); }
});

platformRouter.get("/providers", async (_req, res) => {
  try {
    const r = await pool.query(`SELECT provider_organization_id, provider_name, active_facility_count::int, active_property_ids
      FROM platform_provider_overview ORDER BY provider_name LIMIT 1000`);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

// ---------------------------------------------------------------------------------------------
// M5 OI staff tools. Every route above and below runs behind the is_platform_staff check (per
// request). Reads are recorded in audit_log; every change writes platform_audit_events inside the
// same transaction. Passwords are never logged, stored in plain text or written to an audit row.
// ---------------------------------------------------------------------------------------------

const reasonSchema = z.string().trim().min(1).max(500);
const uuid = z.string().uuid();

async function auditRead(req: AuthedRequest, what: string, detail: Record<string, unknown> = {}) {
  await pool.query(`INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code) VALUES ($1,$2,$3,'GET',$4,$5,200)`,
    [req.auth!.organizationId, req.auth!.userId, "OI staff read: " + what, req.originalUrl.split("?")[0], JSON.stringify(detail)]).catch(() => undefined);
}
async function platformEvent(client: any, req: AuthedRequest, e: { action: string; targetOrg?: string | null; targetId?: string | null; reason?: string | null; before?: unknown; after?: unknown; requestRef?: string | null }) {
  await client.query(`INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state, request_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [req.auth!.userId, req.auth!.organizationId, e.action, e.targetOrg ?? null, e.targetId ?? null, e.reason ?? null,
    e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.requestRef ?? null]);
}
async function tx<T>(res: any, fn: (c: any) => Promise<T>): Promise<T | undefined> {
  let client: any;
  try { client = await pool.connect(); } catch { res.status(503).json({ error: "database_unavailable" }); return undefined; }
  try { await client.query("BEGIN"); const out = await fn(client); await client.query("COMMIT"); return out; }
  catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; }
  finally { client.release(); }
}
class Refusal extends Error { status: number; code: string; constructor(status: number, code: string) { super(code); this.status = status; this.code = code; } }
const DB_CODES = ["organization_hierarchy_same_type_only", "organization_provider_link_requires_confirmation", "organization_hierarchy_cycle",
  "organization_hierarchy_too_deep", "organization_parent_requires_reason", "organization_parent_requires_oi_staff", "organizations_parent_not_self",
  "platform_staff_must_be_internal", "provider_assignment_request_closed",
  "platform_staff_regrant_requires_reason", "provider_facility_assignment_requires_oi_staff", "platform_staff_regrant_requires_oi_staff", "platform_staff_not_revoked", "cannot_change_own_staff_access",
  "usage_settings_requires_oi_staff", "usage_settings_reason_required", "usage_settings_invalid_price", "usage_settings_invalid_cost",
  "usage_settings_invalid_cap", "usage_settings_invalid_warning_ratio", "safety_cap_invalid_company"];
function fail(res: any, err: any, fallback: string) {
  if (err instanceof Refusal) return res.status(err.status).json({ error: err.code });
  const msg = String(err?.message ?? "") + " " + String(err?.constraint ?? "");
  const code = DB_CODES.find((c) => msg.includes(c));
  if (code) return res.status(code.endsWith("requires_oi_staff") ? 403 : 400).json({ error: code });
  if (err?.code === "23505") return res.status(409).json({ error: "already_exists" });
  console.error("OI platform", { outcome: "error", action: fallback, code: String(err?.code ?? "unknown") });
  return res.status(500).json({ error: fallback });
}

// Who am I (the dashboard uses this to show staff tools; the server still checks every request).
platformRouter.get("/me", (req: AuthedRequest, res) => { res.json({ staff: true, user_id: req.auth!.userId }); });


platformRouter.get("/organizations", async (_req, res) => {
  try {
    const r = await pool.query(`SELECT o.id, o.name, o.org_type, o.parent_organization_id,
      (SELECT count(*)::int FROM users u WHERE u.organization_id = o.id AND u.is_active) AS active_users
      FROM organizations o ORDER BY o.org_type, o.name LIMIT 2000`);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

platformRouter.get("/organizations/:id/users", async (req, res) => {
  const id = uuid.safeParse(req.params.id); if (!id.success) return res.status(400).json({ error: "invalid_request" });
  try {
    const r = await pool.query(`SELECT u.id, u.email, u.full_name, m.role, m.is_active, m.is_home FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY m.is_active DESC, u.full_name LIMIT 1000`, [id.data]);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

// (2) Parent link: set or clear, reason required; provider-under-provider needs confirm_provider_link.
// The database trigger enforces staff, reason, same-type, cycle/depth and the provider confirmation,
// and writes the org_parent_changed audit event itself.
const parentSchema = z.object({ parent_organization_id: uuid.nullable(), reason: reasonSchema, confirm_provider_link: z.literal(true).optional() }).strict();
platformRouter.put("/organizations/:id/parent", async (req: AuthedRequest, res) => {
  const id = uuid.safeParse(req.params.id); const b = parentSchema.safeParse(req.body ?? {});
  if (!id.success || !b.success) return res.status(400).json({ error: "invalid_parent_change", fields: b.success ? [] : Object.keys(b.error.flatten().fieldErrors) });
  try {
    const out = await tx(res, async (c) => {
      const org = (await c.query("SELECT id, org_type, parent_organization_id FROM organizations WHERE id=$1 FOR UPDATE", [id.data])).rows[0];
      if (!org) throw new Refusal(404, "organization_not_found");
      if (org.org_type === "internal") throw new Refusal(400, "organization_hierarchy_same_type_only");
      if (b.data.parent_organization_id) {
        const parent = (await c.query("SELECT org_type FROM organizations WHERE id=$1", [b.data.parent_organization_id])).rows[0];
        if (!parent) throw new Refusal(404, "parent_not_found");
        if (parent.org_type !== org.org_type) throw new Refusal(400, "organization_hierarchy_same_type_only");
        if (org.org_type === "service_partner" && b.data.confirm_provider_link !== true) throw new Refusal(409, "organization_provider_link_requires_confirmation");
      }
      await c.query("SELECT set_config('oi.actor_user_id',$1,true), set_config('oi.reason',$2,true), set_config('oi.confirm_provider_link',$3,true)",
        [req.auth!.userId, b.data.reason, b.data.confirm_provider_link === true ? "confirmed" : ""]);
      await c.query("UPDATE organizations SET parent_organization_id=$2 WHERE id=$1", [id.data, b.data.parent_organization_id]);
      const tree = (await c.query(`WITH RECURSIVE up(id, d) AS (SELECT $1::uuid, 0 UNION ALL SELECT o.parent_organization_id, up.d + 1 FROM organizations o JOIN up ON o.id = up.id WHERE o.parent_organization_id IS NOT NULL AND up.d < 20)
        SELECT o.id, o.name, o.org_type, o.parent_organization_id FROM organizations o WHERE o.id IN (SELECT organization_subtree((SELECT id FROM up ORDER BY d DESC LIMIT 1))) ORDER BY o.name`, [id.data])).rows;
      return { id: id.data, parent_organization_id: b.data.parent_organization_id, tree };
    });
    if (out) res.json(out);
  } catch (err) { fail(res, err, "parent_change_failed"); }
});

// (3) Provider assignment requests: review queue.
platformRouter.get("/provider-requests", async (req, res) => {
  const status = z.enum(["pending", "approved", "declined", "withdrawn", "all"]).catch("pending").parse(req.query.status);
  try {
    const r = await pool.query(`SELECT r.id, r.property_id, p.name AS property_name, f.organization_id AS facility_organization_id, fo.name AS facility_organization_name,
      r.provider_organization_id, po.name AS provider_name, r.action, r.reason, r.status, r.requested_at, r.requested_by_user_id, ru.full_name AS requested_by_name,
      r.reviewed_by_user_id, r.reviewed_at, r.review_note
      FROM provider_assignment_requests r JOIN properties p ON p.id = r.property_id JOIN portfolios f ON f.id = p.portfolio_id
      JOIN organizations fo ON fo.id = f.organization_id JOIN organizations po ON po.id = r.provider_organization_id JOIN users ru ON ru.id = r.requested_by_user_id
      WHERE ($1 = 'all' OR r.status = $1) ORDER BY r.requested_at LIMIT 1000`, [status]);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

const reviewSchema = z.object({ reason: reasonSchema }).strict();
for (const decision of ["approve", "decline"] as const) {
  platformRouter.post(`/provider-requests/:id/${decision}`, async (req: AuthedRequest, res) => {
    const id = uuid.safeParse(req.params.id); const b = reviewSchema.safeParse(req.body ?? {});
    if (!id.success || !b.success) return res.status(400).json({ error: "reason_required" });
    try {
      const out = await tx(res, async (c) => {
        const r = (await c.query(`SELECT r.*, f.organization_id AS facility_org FROM provider_assignment_requests r JOIN properties p ON p.id=r.property_id
          JOIN portfolios f ON f.id=p.portfolio_id WHERE r.id=$1 FOR UPDATE OF r`, [id.data])).rows[0];
        if (!r) throw new Refusal(404, "request_not_found");
        if (r.status !== "pending") throw new Refusal(409, "provider_assignment_request_closed");
        const status = decision === "approve" ? "approved" : "declined";
        await c.query("UPDATE provider_assignment_requests SET status=$2, reviewed_by_user_id=$3, reviewed_at=now(), review_note=$4 WHERE id=$1", [r.id, status, req.auth!.userId, b.data.reason]);
        await platformEvent(c, req, { action: "provider_assignment_request_" + status, targetOrg: r.facility_org, targetId: r.property_id, reason: b.data.reason,
          before: { status: "pending" }, after: { status, provider_organization_id: r.provider_organization_id, action: r.action }, requestRef: r.id });
        let assignment = null;
        if (decision === "approve") {
          const before = (await c.query("SELECT revoked_at FROM facility_provider_assignments WHERE property_id=$1 AND provider_organization_id=$2 FOR UPDATE", [r.property_id, r.provider_organization_id])).rows[0];
          if (r.action === "assign") {
            // Names the acting OI staff member for the provider-owned-facility guard in the database.
            await c.query("SELECT set_config('oi.actor_user_id', $1, true)", [req.auth!.userId]);
            assignment = (await c.query(`INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id,revoked_at) VALUES($1,$2,$3,NULL)
              ON CONFLICT(property_id,provider_organization_id) DO UPDATE SET granted_by_user_id=$3, granted_at=now(), revoked_at=NULL RETURNING property_id, provider_organization_id, revoked_at`,
              [r.property_id, r.provider_organization_id, req.auth!.userId])).rows[0];
            await platformEvent(c, req, { action: "provider_assignment_set", targetOrg: r.facility_org, targetId: r.property_id, reason: b.data.reason,
              before: before ? { active: before.revoked_at === null } : { active: false }, after: { active: true, provider_organization_id: r.provider_organization_id }, requestRef: r.id });
          } else {
            assignment = (await c.query(`UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2 AND revoked_at IS NULL
              RETURNING property_id, provider_organization_id, revoked_at`, [r.property_id, r.provider_organization_id])).rows[0] ?? null;
            await platformEvent(c, req, { action: "provider_assignment_revoked", targetOrg: r.facility_org, targetId: r.property_id, reason: b.data.reason,
              before: { active: before ? before.revoked_at === null : false }, after: { active: false, provider_organization_id: r.provider_organization_id }, requestRef: r.id });
          }
        }
        return { id: r.id, status, assignment };
      });
      if (out) res.json(out);
    } catch (err) { fail(res, err, "review_failed"); }
  });
}

// (4) Company and first-admin setup. The temporary password is generated here, hashed, returned
// ONCE in this no-store response for the staff member to hand over, and never logged or audited.
const companySchema = z.object({
  name: z.string().trim().min(1).max(200), org_type: z.enum(["customer", "service_partner"]),
  admin_email: z.string().trim().toLowerCase().email().max(320), admin_full_name: z.string().trim().min(1).max(200), reason: reasonSchema,
  // Service providers only: also create the provider's own general facility (openings not tied to a customer facility).
  create_provider_facility: z.boolean().optional(),
}).strict();
// A provider-owned facility: an ordinary facility in a portfolio owned by the provider company. Access
// stays owner-or-assignment, so no other provider sees it; its openings are billed once, to the provider.
async function createProviderFacility(c: any, req: AuthedRequest, orgId: string, name: string, reason: string) {
  const org = (await c.query("SELECT id, org_type FROM organizations WHERE id=$1 FOR UPDATE", [orgId])).rows[0];
  if (!org) throw new Refusal(404, "organization_not_found");
  if (org.org_type !== "service_partner") throw new Refusal(400, "provider_facility_requires_provider");
  let pf = (await c.query("SELECT id FROM portfolios WHERE organization_id=$1 ORDER BY created_at, id LIMIT 1", [orgId])).rows[0];
  if (!pf) pf = (await c.query("INSERT INTO portfolios (organization_id, name) VALUES ($1,'Main Portfolio') RETURNING id", [orgId])).rows[0];
  const p = (await c.query("INSERT INTO properties (portfolio_id, name) VALUES ($1,$2) RETURNING id, name, portfolio_id", [pf.id, name])).rows[0];
  await platformEvent(c, req, { action: "facility_created", targetOrg: orgId, targetId: p.id, reason, after: { name: p.name, provider_owned: true } });
  return p;
}
const providerFacilitySchema = z.object({ name: z.string().trim().min(1).max(200), reason: reasonSchema }).strict();
platformRouter.post("/providers/:id/facilities", async (req: AuthedRequest, res) => {
  const id = uuid.safeParse(req.params.id); const b = providerFacilitySchema.safeParse(req.body ?? {});
  if (!id.success || !b.success) return res.status(400).json({ error: "invalid_provider_facility" });
  try {
    const out = await tx(res, (c) => createProviderFacility(c, req, id.data, b.data.name, b.data.reason));
    if (out) res.status(201).json({ facility: out });
  } catch (err) { fail(res, err, "provider_facility_create_failed"); }
});
export function generateTemporaryPassword() { return randomBytes(18).toString("base64url"); }
platformRouter.post("/companies", async (req: AuthedRequest, res) => {
  const b = companySchema.safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: "invalid_company", fields: Object.keys(b.error.flatten().fieldErrors) });
  const temporary = generateTemporaryPassword();
  try {
    const hash = await bcrypt.hash(temporary, 12);
    const out = await tx(res, async (c) => {
      if ((await c.query("SELECT 1 FROM users WHERE lower(email)=$1", [b.data.admin_email])).rows.length) throw new Refusal(409, "email_already_registered");
      const org = (await c.query("INSERT INTO organizations (name, org_type) VALUES ($1,$2) RETURNING id, name, org_type", [b.data.name, b.data.org_type])).rows[0];
      const u = (await c.query(`INSERT INTO users (organization_id, email, full_name, role, password_hash, must_change_password, is_test_account, created_by_user_id)
        VALUES ($1,$2,$3,'admin',$4,true,false,$5) RETURNING id, email, full_name, role, must_change_password`, [org.id, b.data.admin_email, b.data.admin_full_name, hash, req.auth!.userId])).rows[0];
      await platformEvent(c, req, { action: "org_created", targetOrg: org.id, targetId: org.id, reason: b.data.reason, after: { name: org.name, org_type: org.org_type } });
      await platformEvent(c, req, { action: "first_admin_invited", targetOrg: org.id, targetId: u.id, reason: b.data.reason,
        after: { email: u.email, full_name: u.full_name, role: "admin", must_change_password: true, temporary_password: "[redacted]" } });
      // Customers need a portfolio in this same transaction so New Property works, as signup does.
      // A provider's own facility already inserts Main Portfolio (select-first); do not insert another.
      if (org.org_type === "customer") {
        await c.query(
          `INSERT INTO portfolios (organization_id, name)
           SELECT $1, 'Main Portfolio'
           WHERE NOT EXISTS (SELECT 1 FROM portfolios WHERE organization_id = $1)`,
          [org.id]
        );
      }
      if (b.data.create_provider_facility && org.org_type !== "service_partner") throw new Refusal(400, "provider_facility_requires_provider");
      const facility = b.data.create_provider_facility ? await createProviderFacility(c, req, org.id, `${org.name} (own facility)`, b.data.reason) : undefined;
      return { organization: org, admin: u, ...(facility ? { provider_facility: facility } : {}) };
    });
    if (out) res.status(201).json({ ...out, temporary_password: temporary, temporary_password_notice: "Shown once. Give it to the admin securely; they must change it at first sign-in." });
  } catch (err) { fail(res, err, "company_create_failed"); }
});

// Staff management: add or remove OI staff (never yourself). The database requires staff to be
// members of the internal OI company and keeps every grant and revocation.
platformRouter.get("/staff", async (_req, res) => {
  try {
    const r = await pool.query(`SELECT s.user_id, u.email, u.full_name, s.granted_at, s.granted_by_user_id, s.grant_reason, s.revoked_at, s.revoked_by_user_id, s.revoke_reason,
      is_platform_staff(s.user_id) AS active FROM platform_staff s JOIN users u ON u.id = s.user_id ORDER BY s.revoked_at NULLS FIRST, u.full_name`);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});
platformRouter.post("/staff", async (req: AuthedRequest, res) => {
  const b = z.object({ email: z.string().trim().toLowerCase().email(), reason: reasonSchema }).strict().safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: "invalid_staff_grant" });
  try {
    const out = await tx(res, async (c) => {
      const u = (await c.query(`SELECT u.id, u.organization_id, o.org_type FROM users u JOIN organizations o ON o.id=u.organization_id WHERE lower(u.email)=$1 AND u.is_active`, [b.data.email])).rows[0];
      if (!u) throw new Refusal(404, "person_not_found_or_inactive");
      if (u.id === req.auth!.userId) throw new Refusal(400, "cannot_change_own_staff_access");
      if (u.org_type !== "internal") throw new Refusal(400, "platform_staff_must_be_internal");
      const existing = (await c.query("SELECT revoked_at FROM platform_staff WHERE user_id=$1", [u.id])).rows[0];
      if (existing && existing.revoked_at === null) throw new Refusal(409, "already_staff");
      if (existing) {
        // Re-grant needs migration 20261030090600 (platform_staff_regrant). Without it, fall back to the old refusal.
        const has = (await c.query("SELECT to_regprocedure('platform_staff_regrant(uuid,uuid,text)') IS NOT NULL AS ok")).rows[0]?.ok === true;
        if (!has) throw new Refusal(409, "staff_previously_revoked");
        await c.query("SELECT platform_staff_regrant($1,$2,$3)", [u.id, req.auth!.userId, b.data.reason]);
        await platformEvent(c, req, { action: "staff_granted", targetOrg: u.organization_id, targetId: u.id, reason: b.data.reason,
          before: { staff: false, previously_revoked_at: existing.revoked_at }, after: { staff: true, regrant: true } });
        return { user_id: u.id, staff: true, regrant: true };
      }
      await c.query("INSERT INTO platform_staff (user_id, granted_by_user_id, grant_reason) VALUES ($1,$2,$3)", [u.id, req.auth!.userId, b.data.reason]);
      await platformEvent(c, req, { action: "staff_granted", targetOrg: u.organization_id, targetId: u.id, reason: b.data.reason, before: { staff: false }, after: { staff: true } });
      return { user_id: u.id, staff: true };
    });
    if (out) res.status(201).json(out);
  } catch (err) { fail(res, err, "staff_grant_failed"); }
});
platformRouter.delete("/staff/:userId", async (req: AuthedRequest, res) => {
  const id = uuid.safeParse(req.params.userId); const b = reviewSchema.safeParse(req.body ?? {});
  if (!id.success || !b.success) return res.status(400).json({ error: "reason_required" });
  if (id.data === req.auth!.userId) return res.status(400).json({ error: "cannot_change_own_staff_access" });
  try {
    const out = await tx(res, async (c) => {
      const row = (await c.query("SELECT s.revoked_at, u.organization_id FROM platform_staff s JOIN users u ON u.id=s.user_id WHERE s.user_id=$1 FOR UPDATE OF s", [id.data])).rows[0];
      if (!row || row.revoked_at !== null) throw new Refusal(404, "not_staff");
      await c.query("UPDATE platform_staff SET revoked_at=now(), revoked_by_user_id=$2, revoke_reason=$3 WHERE user_id=$1", [id.data, req.auth!.userId, b.data.reason]);
      await c.query("UPDATE users SET session_version = session_version + 1 WHERE id=$1", [id.data]);
      await platformEvent(c, req, { action: "staff_revoked", targetOrg: row.organization_id, targetId: id.data, reason: b.data.reason, before: { staff: true }, after: { staff: false } });
      return { user_id: id.data, staff: false };
    });
    if (out) res.json(out);
  } catch (err) { fail(res, err, "staff_revoke_failed"); }
});

// The other staff member, already signed in with an authenticator code, clears this person's
// authenticator and recovery codes. They must enroll again. Sessions issued before the reset die
// because session_version changes. No code or secret is written to the audit record.
platformRouter.post("/staff/:userId/mfa-reset", async (req: AuthedRequest, res) => {
  const id = uuid.safeParse(req.params.userId);
  const body = z.object({ reason: reasonSchema }).strict().safeParse(req.body ?? {});
  if (!id.success || !body.success) return res.status(400).json({ error: "reason_required" });
  try {
    await resetStaffMfa({ actorId: req.auth!.userId, actorOrgId: req.auth!.organizationId, targetId: id.data, reason: body.data.reason });
    res.json({ user_id: id.data, reset: true });
  } catch (error) {
    if (error instanceof StaffMfaError) return res.status(error.status).json({ error: error.code });
    return res.status(503).json({ error: "mfa_unavailable" });
  }
});
