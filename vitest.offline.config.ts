import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      JWT_SECRET: "offline-hosting-smoke-test-only",
      CORS_ORIGINS: "",
    },
    include: ["tests/openingQr.test.ts", "tests/offlineSyncModel.test.ts", "tests/offlineDb.test.ts", "tests/offlineDependencies.test.ts", "tests/offlineFlushRecovery.test.ts", "tests/syncIssuesModel.test.ts", "tests/storageVerification.test.ts", "tests/netlifyHosting.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
  },
});
