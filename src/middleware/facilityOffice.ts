import { Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { AuthedRequest } from "./auth";
import { customerMayOpenFacilityDashboard } from "../services/facilityDashboardAccess";

// Same customer-office rule as the facility dashboard home. Platform staff status
// is not read here, so it cannot grant these pages.
export function requireCustomerOffice(req: AuthedRequest, res: Response, next: NextFunction) {
  pool.query("SELECT org_type FROM organizations WHERE id=$1", [req.auth!.organizationId]).then((org) => {
    if (!customerMayOpenFacilityDashboard(org.rows[0]?.org_type, req.auth!.role)) {
      res.status(403).json({ error: "facility_dashboard_forbidden" });
      return;
    }
    next();
  }).catch(() => {
    if (!res.headersSent) res.status(503).json({ error: "facility_dashboard_unavailable" });
  });
}
