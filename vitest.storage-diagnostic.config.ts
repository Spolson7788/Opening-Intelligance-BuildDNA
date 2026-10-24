import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/stagingStorageDiagnostic.test.ts", "tests/stagingStorageDiagnosticWiring.test.ts"], env: { JWT_SECRET: "synthetic-local-diagnostic-tests-only" } } });
