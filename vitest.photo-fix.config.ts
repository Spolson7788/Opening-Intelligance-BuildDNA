import { defineConfig } from "vitest/config";

// Entirely local: PGlite and fake IndexedDB. No shared database or credentials.
export default defineConfig({ test: {
  environment: "node",
  env: { JWT_SECRET: "local-photo-regression-only", CORS_ORIGINS: "" },
  include: ["tests/photoReservationPrecision.test.ts", "tests/principalChangeRecovery.test.ts"],
  testTimeout: 15000,
} });
