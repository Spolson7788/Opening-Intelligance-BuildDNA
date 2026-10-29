import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, AuthedRequest } from "../middleware/auth";

// M5: a facility admin asks OI staff to assign (or unassign) a service provider for one of the
// active company's own facilities. OI staff decide (see /api/platform/provider-requests). The
// requester may withdraw while it is pending. Facility admins never write assignments here, and
// provider companies never see these requests.
export const providerRequestsRouter = Router();
providerRequestsRouter.use(requireAuth, (req: AuthedRequest, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "facility_admin_required" });
  next();
});
async function customerCompany(orgId: string) {
  const r = await pool.query("SELECT org_type FROM organizations WHERE id=$1", [orgId]);
  return r.rows[0]?.org_type === "customer";
}
async function event(client: any, req: AuthedRequest, action: string, propertyId: string, reason: string, after: unknown, ref: string) {
  await client.query(`INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, after_state, request_ref)
    VALUES ($1,$2,$3,$2,$4,$5,$6,$7)`, [req.auth!.userId, req.auth!.organizationId, action, propertyId, reason, JSON.stringify(after), ref]);
}

// Provider companies a facility may request (names only), and the facility's current assignments.
providerRequestsRouter.get("/options", async (req: AuthedRequest, res) => {
  try {
    if (!(await customerCompany(req.auth!.organizationId))) return res.status(403).json({ error: "facility_admin_required" });
    const providers = (await pool.query("SELECT id, name FROM organizations WHERE org_type='service_partner' ORDER BY name LIMIT 1000")).rows;
    const assigned = (await pool.query(`SELECT a.property_id, a.provider_organization_id FROM facility_provider_assignments a JOIN properties p ON p.id=a.property_id
      JOIN portfolios f ON f.id=p.portfolio_id WHERE f.organization_id=$1 AND a.revoked_at IS NULL`, [req.auth!.organizationId])).rows;
    res.json({ providers, assigned });
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

providerRequestsRouter.get("/", async (req: AuthedRequest, res) => {
  try {
    const r = await pool.query(`SELECT r.id, r.property_id, p.name AS property_name, r.provider_organization_id, po.name AS provider_name, r.action, r.reason, r.status,
      r.requested_at, r.requested_by_user_id, r.reviewed_at, r.review_note FROM provider_assignment_requests r JOIN properties p ON p.id=r.property_id
      JOIN portfolios f ON f.id=p.portfolio_id JOIN organizations po ON po.id=r.provider_organization_id WHERE f.organization_id=$1 ORDER BY r.requested_at DESC LIMIT 500`, [req.auth!.organizationId]);
    res.json(r.rows);
  } catch { res.status(503).json({ error: "service_unavailable" }); }
});

const createSchema = z.object({ property_id: z.string().uuid(), provider_organization_id: z.string().uuid(), action: z.enum(["assign", "unassign"]).default("assign"),
  reason: z.string().trim().min(1).max(500) }).strict();
providerRequestsRouter.post("/", async (req: AuthedRequest, res) => {
  const b = createSchema.safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: "invalid_provider_request", fields: Object.keys(b.error.flatten().fieldErrors) });
  let client: any;
  try { client = await pool.connect(); } catch { return res.status(503).json({ error: "database_unavailable" }); }
  try {
    await client.query("BEGIN");
    const own = await client.query(`SELECT 1 FROM properties p JOIN portfolios f ON f.id=p.portfolio_id JOIN organizations o ON o.id=f.organization_id
      WHERE p.id=$1 AND f.organization_id=$2 AND o.org_type='customer'`, [b.data.property_id, req.auth!.organizationId]);
    if (!own.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "facility_not_found" }); }
    const prov = await client.query("SELECT 1 FROM organizations WHERE id=$1 AND org_type='service_partner'", [b.data.provider_organization_id]);
    if (!prov.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "provider_not_found" }); }
    const r = (await client.query(`INSERT INTO provider_assignment_requests (property_id, provider_organization_id, action, requested_by_user_id, reason)
      VALUES ($1,$2,$3,$4,$5) RETURNING id, property_id, provider_organization_id, action, reason, status, requested_at`,
      [b.data.property_id, b.data.provider_organization_id, b.data.action, req.auth!.userId, b.data.reason])).rows[0];
    await event(client, req, "provider_assignment_requested", b.data.property_id, b.data.reason, { provider_organization_id: r.provider_organization_id, action: r.action }, r.id);
    await client.query("COMMIT");
    res.status(201).json(r);
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") return res.status(409).json({ error: "request_already_pending" });
    if (String(err?.message ?? "").includes("requester_not_facility_admin")) return res.status(403).json({ error: "facility_admin_required" });
    console.error("OI provider request", { outcome: "error", code: String(err?.code ?? "unknown") });
    res.status(500).json({ error: "provider_request_failed" });
  } finally { client.release(); }
});

providerRequestsRouter.post("/:id/withdraw", async (req: AuthedRequest, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const reason = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict().safeParse(req.body ?? {});
  if (!id.success || !reason.success) return res.status(400).json({ error: "invalid_request" });
  let client: any;
  try { client = await pool.connect(); } catch { return res.status(503).json({ error: "database_unavailable" }); }
  try {
    await client.query("BEGIN");
    const r = (await client.query("SELECT id, property_id, status, requested_by_user_id, provider_organization_id FROM provider_assignment_requests WHERE id=$1 FOR UPDATE", [id.data])).rows[0];
    if (!r || r.requested_by_user_id !== req.auth!.userId) { await client.query("ROLLBACK"); return res.status(404).json({ error: "request_not_found" }); }
    if (r.status !== "pending") { await client.query("ROLLBACK"); return res.status(409).json({ error: "provider_assignment_request_closed" }); }
    await client.query("UPDATE provider_assignment_requests SET status='withdrawn' WHERE id=$1", [r.id]);
    await event(client, req, "provider_assignment_request_withdrawn", r.property_id, reason.data.reason ?? "Withdrawn by requester", { status: "withdrawn" }, r.id);
    await client.query("COMMIT");
    res.json({ id: r.id, status: "withdrawn" });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OI provider request withdraw", { outcome: "error", code: String(err?.code ?? "unknown") });
    res.status(500).json({ error: "provider_request_failed" });
  } finally { client.release(); }
});
