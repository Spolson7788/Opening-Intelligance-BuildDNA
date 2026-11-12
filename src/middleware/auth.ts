import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool";
import { readScopeStore } from "../db/tenantScope";

export interface AuthedRequest extends Request {
  auth?: {
    userId: string;
    organizationId: string; // the ACTIVE company for this request (token claim, re-checked every request)
    role: string; // the role in the active company (view-only tree access reports 'viewer')
    homeOrganizationId?: string;
    access?: "member" | "tree_admin" | "tree_view";
    // Companies whose data this request may READ: the active company plus, when the active
    // membership is admin or facilities_manager, its descendant locations. Writes stay on organizationId.
    allowedOrganizationIds?: string[];
    /** True only for an unrevoked platform_staff account. */
    staff?: boolean;
    /** True only when this staff session completed authenticator verification. */
    mfaVerified?: boolean;
    /** Staff password was accepted and the authenticator code is still required. */
    mfaPending?: boolean;
  };
}

// Multi-company (milestone 1): the token names the active company; requireAuth re-checks on every
// request that the person is active, the session is current, and they still hold an active
// membership (or parent-tree access) in that company. Email domain never grants anything.
const AUTH_CONTEXT_COLUMNS = `u.id, u.organization_id AS home_organization_id, u.is_active, u.session_version,
       (to_jsonb(u) ->> 'must_change_password')::boolean AS must_change_password,
       a.organization_id, a.role, a.access,
       (SELECT array_agg(t.organization_id) FROM user_authorized_orgs(u.id) t WHERE t.via_organization_id = $2) AS allowed_organization_ids,
       is_platform_staff(u.id) AS is_platform_staff`;
const AUTH_CONTEXT_FROM = `FROM users u LEFT JOIN LATERAL (SELECT x.organization_id, x.role, x.access FROM user_authorized_orgs(u.id) x WHERE x.organization_id = $2) a ON true
WHERE u.id = $1`;
export const AUTH_CONTEXT_SQL = `SELECT ${AUTH_CONTEXT_COLUMNS},
       (SELECT o.deactivated_at IS NOT NULL FROM organizations o WHERE o.id = $2) AS company_deactivated
${AUTH_CONTEXT_FROM}`;
const AUTH_CONTEXT_SQL_WITHOUT_COMPANY = `SELECT ${AUTH_CONTEXT_COLUMNS}
${AUTH_CONTEXT_FROM}`;

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  // Fail loudly at startup rather than silently signing tokens with an undefined secret.
  throw new Error("JWT_SECRET environment variable is required");
}

// Databases without the memberships migration (e.g. before it is applied) keep today's single-company
// rule: the token company must be the person's own users.organization_id. Only "missing function/table"
// errors fall back; any other failure still denies with 503.
export const LEGACY_AUTH_SQL = `SELECT id, organization_id, organization_id AS home_organization_id, role, is_active, session_version,
              (to_jsonb(users) ->> 'must_change_password')::boolean AS must_change_password
       FROM users WHERE id=$1 AND organization_id=$2`;
export function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01";
}
async function loadAuthContext(userId: string, organizationId: string) {
  try {
    return await pool.query(AUTH_CONTEXT_SQL, [userId, organizationId]);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "42703") {
      return pool.query(AUTH_CONTEXT_SQL_WITHOUT_COMPANY, [userId, organizationId]);
    }
    if (!isMissingSchema(error)) throw error;
    return pool.query(LEGACY_AUTH_SQL, [userId, organizationId]);
  }
}

function requestPath(req: Request): string {
  return (req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "");
}

// A staff password session may enter the emailed code, ask for another, read its own profile, or change its password.
// It cannot use staff tools or any other company data until that code is accepted.
function staffMfaPath(path: string): boolean {
  return path.endsWith("/auth/mfa/verify") || path.endsWith("/auth/mfa/resend") || path.endsWith("/auth/mfa/status")
    || path.endsWith("/auth/me") || path.endsWith("/auth/change-password");
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  // Correlate denied reads and writes without logging credentials, URLs,
  // query parameters, record IDs or request bodies.
  const deny = (status: number, error: string, outcome = error) => {
    const reference = randomUUID();
    res.setHeader("X-OI-Auth-Reference", reference);
    res.setHeader("Cache-Control", "no-store");
    console.info("OI authorization", { reference, outcome });
    return res.status(status).json({ error, reference });
  };
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return deny(401, "missing_token");
  }
  const token = header.slice("Bearer ".length);
  let payload: { userId: string; organizationId: string; role: string; sessionVersion?: number; mfaVerified?: boolean; mfaPending?: boolean };
  try {
    payload = jwt.verify(token, JWT_SECRET as string) as typeof payload;
  } catch (error) {
    return deny(401, "invalid_token", error instanceof jwt.TokenExpiredError ? "token_expired" : "invalid_token");
  }
  try {
    const current = await loadAuthContext(payload.userId, payload.organizationId);
    const user = current.rows[0];
    if (!user) return deny(401, "invalid_token_subject");
    if (user.company_deactivated === true) return deny(403, "company_deactivated");
    if (!user.is_active) return deny(403, "account_deactivated");

    if (!user.organization_id || !user.role || user.organization_id !== payload.organizationId) return deny(403, "membership_inactive");
    if ((payload.sessionVersion ?? 0) !== (user.session_version ?? 0)) return deny(401, "session_revoked");

    // The database is authoritative on every request. A role change or account
    // deactivation therefore takes effect immediately instead of waiting for a
    // previously issued JWT to expire.
    // M5: a forced password change blocks everything except reading your own profile,
    // changing the password, and (for staff) the authenticator step.
    const path = requestPath(req);
    if (user.must_change_password === true) {
      if (!path.endsWith("/auth/change-password") && !path.endsWith("/auth/me") && !path.includes("/auth/mfa/")) return deny(403, "password_change_required");
    }

    // Staff powers require a server-signed mfaVerified claim. A password-only or
    // not-yet-confirmed staff token is not a staff session. Customers never take this branch.
    const staff = user.is_platform_staff === true;
    const mfaVerified = staff && payload.mfaVerified === true && payload.mfaPending !== true;
    if (staff && !mfaVerified && !staffMfaPath(path)) return deny(403, "mfa_required");

    req.auth = {
      userId: user.id,
      organizationId: user.organization_id,
      role: user.role,
      homeOrganizationId: user.home_organization_id ?? user.organization_id,
      access: user.access ?? "member",
      allowedOrganizationIds: Array.from(new Set([user.organization_id, ...((user.allowed_organization_ids as string[] | null) ?? [])])),
      staff,
      mfaVerified,
      mfaPending: staff && !mfaVerified,
    };
    const method = (req.method || "GET").toUpperCase();
    const wantsTree = req.query?.scope === "tree" || String(req.headers["x-oi-scope"] ?? "").toLowerCase() === "tree";
    const extra = (method === "GET" || method === "HEAD") && wantsTree
      ? req.auth.allowedOrganizationIds!.filter((id) => id !== req.auth!.organizationId) : [];
    return readScopeStore.run({ extra }, () => next());
  } catch {
    // Failure to check current authority must deny the request without claiming
    // a valid credential is invalid or prompting unnecessary password changes.
    return deny(503, "authorization_service_unavailable");
  }
}

// Restrict a route to specific roles, e.g. requireRole('admin', 'facilities_manager')
export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}
