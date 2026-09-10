import express from "express";
import cors from "cors";
import { openingsRouter } from "./routes/openings";
import { eventsRouter } from "./routes/events";
import { authRouter } from "./routes/auth";
import { hardwareRouter } from "./routes/hardware";
import { photosRouter } from "./routes/photos";
import { portfolioRouter } from "./routes/portfolio";
import { exportRouter } from "./routes/export";
import { auditLogRouter } from "./routes/auditLogRoute";
import { documentsRouter } from "./routes/documents";
import { workOrdersRouter } from "./routes/workOrders";
import { maintenanceSchedulesRouter } from "./routes/maintenanceSchedulesRoute";

// In local dev, the field-app/dashboard talk to the API through their own
// Vite dev-server proxy, so this never mattered. Once each piece is deployed
// to its own domain (dashboard.yourapp.com, field.yourapp.com, api.yourapp.com),
// cross-origin requests are the normal case, not an edge case — so this is
// required, not optional, for a cloud deployment to work at all.
export function corsOriginsFromEnv(): string[] {
  return (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function createApp() {
  const app = express();
  const allowedOrigins = corsOriginsFromEnv();

  app.use(
    cors({
      origin(origin, callback) {
        // Allow no-origin requests (curl, server-to-server, mobile webviews in
        // some configurations) and anything on the explicit allowlist.
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        callback(new Error(`Origin ${origin} not allowed by CORS_ORIGINS`));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "10mb" })); // generous limit for base64 photo payloads during MVP

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/openings", openingsRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/hardware", hardwareRouter);
  app.use("/api/photos", photosRouter);
  app.use("/api/portfolio", portfolioRouter);
  app.use("/api/export", exportRouter);
  app.use("/api/audit-log", auditLogRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/work-orders", workOrdersRouter);
  app.use("/api/maintenance-schedules", maintenanceSchedulesRouter);

  return app;
}
