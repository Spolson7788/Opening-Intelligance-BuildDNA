import { defineConfig } from "vitest/config";

// In-memory tests only. No globalSetup, so this does not run migrations against any database server.
export default defineConfig({
  test: {
    environment: "node",
    env: {
      JWT_SECRET: "test-secret-for-vitest-do-not-use-in-production",
      RESEND_API_KEY: "test-not-a-real-resend-key",
      PASSWORD_RESET_FROM_EMAIL: "Opening Intelligence <noreply@example.invalid>",
      VITEST: "true",
    },
    fileParallelism: false,
    testTimeout: 300000,
    hookTimeout: 180000,
    include: [
      "tests/staffMfaCrypto.test.ts",
      "tests/staffMfa.integration.test.ts",
      "tests/authAvailability.test.ts",
      "tests/staffRegrant.test.ts",
      "tests/multiCompanyM1.test.ts",
      "tests/multiCompanyM2.test.ts",
      "tests/multiCompanyM5.test.ts",
      "tests/recognitionUsageSettings.test.ts",
      "tests/recognitionUsageReport.test.ts",
      "tests/recognitionRunRecords.test.ts",
    ],
  },
});
