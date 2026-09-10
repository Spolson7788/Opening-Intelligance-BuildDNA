import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

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

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
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
    req.auth = payload;
    next();
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
