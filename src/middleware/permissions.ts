import { Response, NextFunction } from "express";
import { AuthedRequest } from "./auth";

// The permission model, stated plainly in one place rather than scattered
// across route handlers.
//
// Role ladder (Stephan, 2026-10-27): each role is a strict superset of the one
// below: viewer < inspector < technician < facilities_manager < admin.
//   inspector          = read + record findings (condition observations,
//                        inspection events, photos, inspection-report
//                        documents, service requests).
//   technician         = inspector + service work and authorized edits
//                        (hardware, frames, door leaves, completion, work
//                        orders, service events, labels, opening creation,
//                        all document types).
//   facilities_manager = technician + schedule upload, bulk import,
//                        facility/building/opening management.
//   admin              = facilities_manager + team management and provider
//                        assignment.
// The same ladder applies in owner organizations (their own facilities) and in
// provider organizations, including OI (assigned facilities only). Enforced by
// tests/inspectorPermissions.test.ts ("role ladder"). Details:
//
//   admin              — everything, including team management.
//   facilities_manager — everything EXCEPT team management (that stays
//                        admin-only via requireRole on the specific routes
//                        in auth.ts, unaffected by this middleware).
//   technician          — read everything; write only the specific field
//                        actions listed in FIELD_WRITE_ACTIONS below, plus
//                        property/building/opening creation (setup).
//                        Technicians record exactly what they see in the
//                        field, so they may record condition observations
//                        (Stephan, 2026-10-27 12:30 PM MST). Observations use
//                        their own route; no sync path carries them.
//   inspector           — inspectors check and document; they don't change
//                        hardware (Stephan, 2026-10-27). Read everything
//                        (still facility- and organization-scoped by each
//                        handler). Writes are limited to INSPECTOR_WRITE_ACTIONS:
//                        inspection events, condition observations, offline
//                        sync of inspection events only, photo capture,
//                        inspection-report documents, and service requests.
//                        Denied: hardware changes, component sync, frame,
//                        door leaves, completion, work-order status, health
//                        score recompute, purchasing review, setup creation,
//                        labels, photo/document deletion, schedule upload.
//                        Inspectors may be facility staff or provider staff;
//                        either way they are scoped by organization and, for
//                        providers, by active facility assignment.
//   viewer              — read-only, full stop.
//
// Schedule documents (facility-schedules router, its own role check):
// facility staff review schedule documents and hand them off; only admins and
// facilities managers of the owner organization, or of an assigned provider
// organization, upload. OI staff upload on a facility's behalf only by
// assigning the OI organization as a provider; there is no platform-wide role.
//
// Technician setup permits exactly property, building and opening creation.
// Existing handlers enforce organization ownership of each parent. Bulk import,
// portfolio creation and team administration remain outside technician writes.
const FIELD_WRITE_ACTIONS: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/api\/service-requests\/?$/ },
  { method: "POST", pattern: /^\/api\/labels\/generations$/ },
  { method: "POST", pattern: /^\/api\/events\/service-events$/ },
  { method: "POST", pattern: /^\/api\/events\/inspection-events$/ },
  { method: "POST", pattern: /^\/api\/condition-history\/observations$/ },
  { method: "POST", pattern: /^\/api\/hardware$/ },
  { method: "POST", pattern: /^\/api\/hardware-recognition\/runs$/ },
  { method: "POST", pattern: /^\/api\/hardware-recognition\/runs\/[^/]+\/confirm$/ },
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
  { method: "PUT", pattern: /^\/api\/openings\/[^/]+\/frame$/ },
  { method: "POST", pattern: /^\/api\/openings\/[^/]+\/(door-leaves|complete)$/ },
  { method: "POST", pattern: /^\/api\/purchasing\/review$/ },
  { method: "POST", pattern: /^\/api\/purchasing\/send$/ },
  { method: "POST", pattern: /^\/api\/events\/inspection-events\/[^/]+\/email$/ },
  { method: "POST", pattern: /^\/api\/events\/fire-door-deficiencies\/[^/]+\/repair$/ },
];

const INSPECTOR_WRITE_ACTIONS: Array<{ method: string; pattern: RegExp; body?: (b: any) => boolean }> = [
  { method: "POST", pattern: /^\/api\/events\/inspection-events$/ },
  { method: "POST", pattern: /^\/api\/condition-history\/observations$/ },
  { method: "POST", pattern: /^\/api\/sync\/operations$/, body: (b) => b?.entity_type === "inspection_event" },
  { method: "POST", pattern: /^\/api\/photos\/presign$/ },
  { method: "POST", pattern: /^\/api\/photos\/offline\/(reserve|confirm|recover-reservation)$/ },
  { method: "POST", pattern: /^\/api\/photos$/ },
  { method: "POST", pattern: /^\/api\/documents\/presign$/ },
  { method: "POST", pattern: /^\/api\/documents$/, body: (b) => b?.document_type === "inspection_report" },
  { method: "POST", pattern: /^\/api\/service-requests\/?$/ },
  { method: "POST", pattern: /^\/api\/purchasing\/send$/ },
  { method: "POST", pattern: /^\/api\/events\/inspection-events\/[^/]+\/email$/ },
  { method: "POST", pattern: /^\/api\/events\/fire-door-deficiencies\/[^/]+\/repair$/ },
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

  if (role === "inspector") {
    const allowed = INSPECTOR_WRITE_ACTIONS.some((a) => a.method === req.method && a.pattern.test(path) && (!a.body || a.body(req.body)));
    if (allowed) return next();
    return res.status(403).json({ error: "insufficient_role_for_action" });
  }

  if (role === "technician") {
    const allowed = FIELD_WRITE_ACTIONS.some((a) => a.method === req.method && a.pattern.test(path));
    if (allowed) return next();
    return res.status(403).json({ error: "insufficient_role_for_action" });
  }

  // viewer, or any other/unrecognized role — read-only.
  return res.status(403).json({ error: "read_only_role" });
}
