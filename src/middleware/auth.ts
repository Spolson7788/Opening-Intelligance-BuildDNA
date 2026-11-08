import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
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
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }
  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, JWT_SECRET as string) as {
      userId: string;
      organizationId: string;
      role: string;
    };
    const current = await pool.query(
      `SELECT id, organization_id, role, is_active
       FROM users WHERE id=$1 AND organization_id=$2`,
      [payload.userId, payload.organizationId],
    );
    const user = current.rows[0];
    if (!user) return res.status(401).json({ error: "invalid_token_subject" });
    if (!user.is_active) return res.status(403).json({ error: "account_deactivated" });

    // The database is authoritative on every request. A role change or account
    // deactivation therefore takes effect immediately instead of waiting for a
    // previously issued JWT to expire.
    req.auth = {
      userId: user.id,
      organizationId: user.organization_id,
      role: user.role,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "invalid_token" });
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
