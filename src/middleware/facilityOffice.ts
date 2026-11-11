import { Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { AuthedRequest } from "./auth";
import { mayOpenFacilityDashboard } from "../services/facilityDashboardAccess";

// Same office rule as the facility dashboard home. Verified staff still need an
// administrator or facilities-manager membership on this company.
export function requireCustomerOffice(req: AuthedRequest, res: Response, next: NextFunction) {
  const auth = req.auth!;
  pool.query("SELECT org_type FROM organizations WHERE id=$1", [auth.organizationId]).then((org) => {
    if (!mayOpenFacilityDashboard({
      orgType: org.rows[0]?.org_type,
      role: auth.role,
      staff: auth.staff === true,
      mfaVerified: auth.mfaVerified === true,
    })) {
      res.status(403).json({ error: "facility_dashboard_forbidden" });
      return;
    }
    next();
  }).catch(() => {
    if (!res.headersSent) res.status(503).json({ error: "facility_dashboard_unavailable" });
  });
}
