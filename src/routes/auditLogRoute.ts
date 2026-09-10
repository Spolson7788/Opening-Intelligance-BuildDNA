import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, requireRole, AuthedRequest } from "../middleware/auth";

export const auditLogRouter = Router();
auditLogRouter.use(requireAuth);

// Who can see the audit log is itself a real access decision, same
// reasoning as team management: seeing who-did-what across the whole org
// is management-level visibility, not something every field role needs.
auditLogRouter.get("/", requireRole("admin", "facilities_manager"), async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  try {
    const result = await pool.query(
      `SELECT al.id, al.action, al.method, al.path, al.request_body, al.status_code, al.created_at,
              u.full_name AS user_full_name, u.email AS user_email, u.id AS user_id
       FROM audit_log al
       JOIN users u ON u.id = al.user_id
       WHERE al.organization_id = $1
       ORDER BY al.created_at DESC
       LIMIT $2`,
      [orgId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
