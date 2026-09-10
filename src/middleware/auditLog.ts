import { Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { AuthedRequest } from "./auth";

// Human-readable labels for the mutations worth auditing. Deliberately NOT
// exhaustive — a few write endpoints are excluded on purpose:
//   - recompute-health-score: a derived computation triggered as a side
//     effect of normal field work, not a change a human actually made.
//   - photos/presign: step 1 of a two-step upload — the presign itself
//     creates nothing. The actual POST /api/photos (confirm) is what's
//     logged.
const AUDIT_ACTIONS: Array<{ method: string; pattern: RegExp; label: string }> = [
  { method: "POST", pattern: /^\/api\/openings$/, label: "Created opening" },
  { method: "POST", pattern: /^\/api\/openings\/bulk-import$/, label: "Bulk imported openings" },
  { method: "POST", pattern: /^\/api\/hardware$/, label: "Added hardware" },
  { method: "POST", pattern: /^\/api\/hardware\/bulk-import$/, label: "Bulk imported hardware" },
  { method: "PATCH", pattern: /^\/api\/hardware\/[^/]+$/, label: "Updated hardware" },
  { method: "DELETE", pattern: /^\/api\/hardware\/[^/]+$/, label: "Removed hardware" },
  { method: "POST", pattern: /^\/api\/events\/service-events$/, label: "Logged service event" },
  { method: "POST", pattern: /^\/api\/events\/inspection-events$/, label: "Logged inspection event" },
  { method: "POST", pattern: /^\/api\/photos$/, label: "Uploaded photo" },
  { method: "DELETE", pattern: /^\/api\/photos\/[^/]+$/, label: "Deleted photo" },
  { method: "POST", pattern: /^\/api\/documents$/, label: "Uploaded document" },
  { method: "DELETE", pattern: /^\/api\/documents\/[^/]+$/, label: "Deleted document" },
  { method: "POST", pattern: /^\/api\/work-orders$/, label: "Created work order" },
  { method: "PATCH", pattern: /^\/api\/work-orders\/[^/]+$/, label: "Updated work order" },
  { method: "POST", pattern: /^\/api\/work-orders\/[^/]+\/status$/, label: "Updated work order status" },
  { method: "POST", pattern: /^\/api\/maintenance-schedules$/, label: "Created maintenance schedule" },
  { method: "PATCH", pattern: /^\/api\/maintenance-schedules\/[^/]+$/, label: "Updated maintenance schedule" },
  { method: "POST", pattern: /^\/api\/maintenance-schedules\/generate-due$/, label: "Manually triggered due maintenance" },
  { method: "POST", pattern: /^\/api\/portfolio\/properties$/, label: "Created property" },
  { method: "POST", pattern: /^\/api\/portfolio\/buildings$/, label: "Created building" },
  { method: "POST", pattern: /^\/api\/auth\/register$/, label: "Invited team member" },
  { method: "PATCH", pattern: /^\/api\/auth\/users\/[^/]+$/, label: "Updated team member" },
];

function redact(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const key of Object.keys(clone)) {
    if (key.toLowerCase().includes("password")) clone[key] = "[redacted]";
  }
  return clone;
}

// Attached after requireAuth (and, where present, enforceRolePermissions) on
// every router. Logs on res.on("finish") so the actual outcome status code
// is known — a write that got rejected downstream (e.g. a 404 for a
// nonexistent opening_id) is correctly not recorded as a successful change.
export function auditLog(req: AuthedRequest, res: Response, next: NextFunction) {
  const path = req.originalUrl.split("?")[0];
  const match = AUDIT_ACTIONS.find((a) => a.method === req.method && a.pattern.test(path));

  if (match && req.auth) {
    const { organizationId, userId } = req.auth;
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return; // only successful mutations
      pool
        .query(
          `INSERT INTO audit_log (organization_id, user_id, action, method, path, request_body, status_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [organizationId, userId, match.label, req.method, path, JSON.stringify(redact(req.body)), res.statusCode]
        )
        .catch((err) => {
          // Audit logging must never break the actual request — the
          // response has already been sent by the time this runs, so the
          // only thing to do with a logging failure is report it, not
          // surface it to the user.
          console.error("audit log insert failed:", err);
        });
    });
  }

  next();
}
