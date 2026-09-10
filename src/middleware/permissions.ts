import { Response, NextFunction } from "express";
import { AuthedRequest } from "./auth";

// The permission model, stated plainly in one place rather than scattered
// across route handlers:
//
//   admin              — everything, including team management.
//   facilities_manager — everything EXCEPT team management (that stays
//                        admin-only via requireRole on the specific routes
//                        in auth.ts, unaffected by this middleware).
//   technician          — read everything; write only the specific field
//   inspector            actions listed in FIELD_WRITE_ACTIONS below.
//                        Treated identically to each other on purpose: the
//                        app has no UI distinction between what a
//                        technician vs. an inspector logs (both use the
//                        same field app), and without a real customer
//                        drawing that line, guessing at a finer split would
//                        be exactly the kind of thing this project has
//                        consistently avoided doing without real input.
//   viewer              — read-only, full stop.
//
// Deliberately NOT included: creating openings, bulk imports (openings or
// hardware), and anything under /api/portfolio (properties, buildings,
// forecasts, alerts) — those are portfolio-setup and reporting actions, not
// day-to-day field work, and the field app itself has never exposed opening
// creation for the same reason.
const FIELD_WRITE_ACTIONS: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/api\/events\/service-events$/ },
  { method: "POST", pattern: /^\/api\/events\/inspection-events$/ },
  { method: "POST", pattern: /^\/api\/hardware$/ },
  { method: "PATCH", pattern: /^\/api\/hardware\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/api\/hardware\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/photos\/presign$/ },
  { method: "POST", pattern: /^\/api\/photos$/ },
  { method: "DELETE", pattern: /^\/api\/photos\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/documents\/presign$/ },
  { method: "POST", pattern: /^\/api\/documents$/ },
  { method: "DELETE", pattern: /^\/api\/documents\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/work-orders\/[^/]+\/status$/ },
  { method: "POST", pattern: /^\/api\/openings\/[^/]+\/recompute-health-score$/ },
];

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function enforceRolePermissions(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ error: "missing_token" });

  const { role } = req.auth;
  if (role === "admin" || role === "facilities_manager") return next();

  if (!WRITE_METHODS.has(req.method)) return next(); // reads are always allowed for every role

  // This middleware is attached inside each sub-router (after requireAuth),
  // where req.path is relative to that router's mount point (e.g. just
  // "/abc123" inside a router mounted at /api/hardware) — not the full URL.
  // req.originalUrl always reflects the complete request path regardless of
  // mounting depth, which is what the shared, full-path patterns above
  // actually need to match against.
  const path = req.originalUrl.split("?")[0];

  if (role === "technician" || role === "inspector") {
    const allowed = FIELD_WRITE_ACTIONS.some((a) => a.method === req.method && a.pattern.test(path));
    if (allowed) return next();
    return res.status(403).json({ error: "insufficient_role_for_action" });
  }

  // viewer, or any other/unrecognized role — read-only.
  return res.status(403).json({ error: "read_only_role" });
}
