import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool";

export interface AuthedRequest extends Request {
  auth?: {
    userId: string;
    organizationId: string;
    role: string;
  };
}

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  // Fail loudly at startup rather than silently signing tokens with an undefined secret.
  throw new Error("JWT_SECRET environment variable is required");
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
  let payload: { userId: string; organizationId: string; role: string; sessionVersion?: number };
  try {
    payload = jwt.verify(token, JWT_SECRET as string) as typeof payload;
  } catch (error) {
    return deny(401, "invalid_token", error instanceof jwt.TokenExpiredError ? "token_expired" : "invalid_token");
  }
  try {
    const current = await pool.query(
      `SELECT id, organization_id, role, is_active, session_version
       FROM users WHERE id=$1 AND organization_id=$2`,
      [payload.userId, payload.organizationId],
    );
    const user = current.rows[0];
    if (!user) return deny(401, "invalid_token_subject");
    if (!user.is_active) return deny(403, "account_deactivated");

    if ((payload.sessionVersion ?? 0) !== (user.session_version ?? 0)) return deny(401, "session_revoked");

    // The database is authoritative on every request. A role change or account
    // deactivation therefore takes effect immediately instead of waiting for a
    // previously issued JWT to expire.
    req.auth = {
      userId: user.id,
      organizationId: user.organization_id,
      role: user.role,
    };
    return next();
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
