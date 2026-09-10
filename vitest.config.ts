import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/opening_intel_test";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./tests/globalSetup.ts",
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: "test-secret-for-vitest-do-not-use-in-production",
      CORS_ORIGINS: "",
    },
    // These tests hit a real Postgres through a shared connection pool —
    // running test files in parallel worker processes each with their own
    // pool against the same DB adds contention and flakiness for no real
    // speed win at this suite's size. Sequential is simpler to reason about.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 20000,
  },
});
