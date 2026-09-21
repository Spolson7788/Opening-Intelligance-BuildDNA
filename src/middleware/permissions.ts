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
// Technician setup now permits exactly property, building and opening creation.
// Existing handlers enforce organization ownership of each parent. Bulk import,
// portfolio creation and team administration remain outside technician writes.
const FIELD_WRITE_ACTIONS: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/api\/events\/service-events$/ },
  { method: "POST", pattern: /^\/api\/events\/inspection-events$/ },
  { method: "POST", pattern: /^\/api\/hardware$/ },
  { method: "PATCH", pattern: /^\/api\/hardware\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/api\/hardware\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/photos\/presign$/ },
  { method: "POST", pattern: /^\/api\/photos\/offline\/(reserve|confirm|recover-reservation)$/ },
  { method: "POST", pattern: /^\/api\/photos$/ },
  { method: "DELETE", pattern: /^\/api\/photos\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/documents\/presign$/ },
  { method: "POST", pattern: /^\/api\/documents$/ },
  { method: "DELETE", pattern: /^\/api\/documents\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/work-orders\/[^/]+\/status$/ },
  { method: "POST", pattern: /^\/api\/openings\/[^/]+\/recompute-health-score$/ },
  { method: "POST", pattern: /^\/api\/sync\/components$/ },
  { method: "POST", pattern: /^\/api\/sync\/operations$/ },
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

  if (role === "technician" && req.method === "POST" &&
      ["/api/portfolio/properties", "/api/portfolio/buildings", "/api/openings"].includes(path)) return next();

  if (role === "technician" || role === "inspector") {
    const allowed = FIELD_WRITE_ACTIONS.some((a) => a.method === req.method && a.pattern.test(path));
    if (allowed) return next();
    return res.status(403).json({ error: "insufficient_role_for_action" });
  }

  // viewer, or any other/unrecognized role — read-only.
  return res.status(403).json({ error: "read_only_role" });
}
