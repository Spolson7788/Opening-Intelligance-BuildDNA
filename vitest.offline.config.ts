import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      JWT_SECRET: "offline-hosting-smoke-test-only",
      CORS_ORIGINS: "",
    },
    include: ["tests/previewAccess.test.ts", "tests/authResponse.test.ts", "tests/accountRecovery.test.ts","tests/loginForm.test.ts","tests/loginDiagnostics.test.ts","tests/mediaAssociationLabel.test.ts","tests/authAvailability.test.ts","tests/openingLoadFailure.test.ts","tests/openingCacheAccess.test.ts","tests/openingQr.test.ts", "tests/openingCompletionRequirements.test.ts", "tests/offlineSyncModel.test.ts", "tests/offlineDb.test.ts", "tests/offlineDependencies.test.ts", "tests/offlineFlushRecovery.test.ts", "tests/syncIssuesModel.test.ts", "tests/photoSizeRecovery.test.ts", "tests/storageVerification.test.ts", "tests/netlifyHosting.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
  },
});
