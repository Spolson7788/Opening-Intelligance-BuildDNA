import {commercialRouter} from './routes/commercial';
import {sandboxFinanceRouter} from './routes/sandboxFinance';
import {planningRouter} from './routes/planning';
import {CommercialStore} from './services/commercialStorage';
import {lifecycleOperationsRouter} from './routes/lifecycleOperations';
import {lifecycleRouter} from './routes/lifecycle';
import {conditionHistoryRouter} from './routes/conditionHistory';
import {accountRecoveryRouter} from "./routes/accountRecovery";
import {recognitionRouter} from "./routes/recognition";
import {recognitionRunsRouter} from "./routes/recognitionRuns";
import {recordRecognitionAccessDenials} from "./middleware/recognitionAccessDenials";
import {branchesRouter} from "./routes/branches";
import { geoRouter } from "./routes/geo";
import {providerAssignmentsRouter} from "./routes/providerAssignments";
import { facilitySchedulesRouter } from "./routes/facilitySchedules";
import { scheduleImportsRouter } from "./routes/scheduleImports";
import { scheduleComparisonsRouter } from "./routes/scheduleComparisons";
import {purchasingRouter} from "./routes/purchasing";
import express from "express";
import cors from "cors";
import { openingsRouter } from "./routes/openings";
import { eventsRouter } from "./routes/events";
import { authRouter } from "./routes/auth";
import { membersRouter, invitesPublicRouter } from "./routes/members";
import { hardwareRouter } from "./routes/hardware";
import { photosRouter } from "./routes/photos";
import { portfolioRouter } from "./routes/portfolio";
import { platformRouter } from "./routes/platform";
import { providerRequestsRouter } from "./routes/providerRequests";
import { locationsRouter } from "./routes/locations";
import { exportRouter } from "./routes/export";
import { auditLogRouter } from "./routes/auditLogRoute";
import { documentsRouter } from "./routes/documents";
import { workOrdersRouter } from "./routes/workOrders";
import { maintenanceSchedulesRouter } from "./routes/maintenanceSchedulesRoute";
import { syncRouter } from "./routes/sync";
import { labelsRouter } from "./routes/labels";
import { serviceRequestsRouter } from "./routes/serviceRequests";
import { enforceJsonStructure } from './middleware/jsonStructure';
import { createPublicQrRouter } from './routes/publicQr';

// In local dev, the field-app/dashboard talk to the API through their own
// Vite dev-server proxy, so this never mattered. Once each piece is deployed
// to its own domain (dashboard.yourapp.com, field.yourapp.com, api.yourapp.com),
// cross-origin requests are the normal case, not an edge case — so this is
// required, not optional, for a cloud deployment to work at all.
export function corsOriginsFromEnv(): string[] {
  // Netlify gives every deploy an immutable URL. Include the runtime-provided
  // deploy URLs so a frozen deployment can call its own API without requiring
  // a new CORS_ORIGINS edit for every build.
  return [
    ...(process.env.CORS_ORIGINS || "").split(","),
    process.env.DEPLOY_URL || "",
    process.env.DEPLOY_PRIME_URL || "",
    process.env.URL || "",
  ]
    .map((o) => o.trim())
    .filter((origin, index, origins) => Boolean(origin) && origins.indexOf(origin) === index);
}

function netlifySiteHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".netlify.app")) return null;
    const deploySeparator = url.hostname.indexOf("--");
    return deploySeparator >= 0 ? url.hostname.slice(deploySeparator + 2) : url.hostname;
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes(origin)) return true;
  const requestedSite = netlifySiteHost(origin);
  return Boolean(
    requestedSite &&
      allowedOrigins.some((allowedOrigin) => netlifySiteHost(allowedOrigin) === requestedSite)
  );
}

export function createApp(options: { retainedDocumentRecoveryAllowed?: ()=>boolean; accountRecoveryEnabled?: boolean; commercialStore?: CommercialStore; commercialInputsOnly?: boolean; commercialInputsEnabled?: boolean; facilityBudgetEnabled?: boolean; planningSandboxEnabled?: boolean; legacyDocumentsEnabled?: boolean } = {}) {
  const app = express();
  app.locals.commercialStore=options.commercialStore;
  app.locals.retainedDocumentRecoveryAllowed=options.retainedDocumentRecoveryAllowed;
  app.locals.commercialInputsOnly=options.commercialInputsOnly===true;
  app.locals.commercialInputsEnabled=options.commercialInputsEnabled===true;
  app.locals.facilityBudgetEnabled=options.facilityBudgetEnabled===true;
  app.locals.planningSandboxEnabled=options.planningSandboxEnabled===true;
  const allowedOrigins = corsOriginsFromEnv();

  app.use(
    cors({
      origin(origin, callback) {
        // Allow no-origin requests (curl, server-to-server, mobile webviews in
        // some configurations) and anything on the explicit allowlist.
        if (!origin || allowedOrigins.length === 0 || isAllowedOrigin(origin, allowedOrigins)) {
          return callback(null, true);
        }
        callback(new Error(`Origin ${origin} not allowed by CORS_ORIGINS`));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "10mb" })); // generous limit for base64 photo payloads during MVP
  app.use(enforceJsonStructure);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use('/api/qr', createPublicQrRouter());

  app.use('/api/commercial',commercialRouter);
  app.use('/api/planning',planningRouter);
  app.use('/api/sandbox-finance',sandboxFinanceRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/locations", locationsRouter);
  app.use("/api/geo", geoRouter);
  app.use("/api/members", membersRouter);
  app.use("/api/invites", invitesPublicRouter);
  app.use("/api/recognition", recordRecognitionAccessDenials); // 401/403 records, before auth
  app.use("/api/recognition/runs", recognitionRunsRouter);
  app.use("/api/recognition", recognitionRouter);
  if (options.accountRecoveryEnabled) app.use("/api/account-recovery", accountRecoveryRouter);
  app.use("/api/provider-assignments",providerAssignmentsRouter);
  app.use("/api/facility-schedules", facilitySchedulesRouter);
  app.use("/api/schedule-imports", scheduleImportsRouter);
  app.use("/api/schedule-comparisons", scheduleComparisonsRouter);
  app.use("/api/branches",branchesRouter);
  app.use("/api/purchasing",purchasingRouter);
  app.use("/api/openings", openingsRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/hardware", hardwareRouter);
  app.use("/api/photos", photosRouter);
  app.use("/api/portfolio", portfolioRouter);
  app.use("/api/platform", platformRouter);
  app.use("/api/provider-requests", providerRequestsRouter);
  app.use("/api/export", exportRouter);
  app.use("/api/audit-log", auditLogRouter);
  if (options.legacyDocumentsEnabled === false) {
    app.use("/api/documents", (_req, res) => { res.status(503).json({ error: "documents_unavailable" }); });
  } else {
    app.use("/api/documents", documentsRouter);
  }
  app.use("/api/work-orders", workOrdersRouter);
  app.use("/api/maintenance-schedules", maintenanceSchedulesRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/labels", labelsRouter);
  app.use("/api/service-requests", serviceRequestsRouter);
  app.use('/api/lifecycle', lifecycleRouter);
  app.use('/api/condition-history', conditionHistoryRouter);
  app.use('/api/lifecycle', lifecycleOperationsRouter);

  return app;
}
