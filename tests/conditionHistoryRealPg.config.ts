import { defineConfig } from 'vitest/config';
// Deliberately no globalSetup (the general runner drops/recreates databases).
export default defineConfig({ test: {
  environment: 'node', include: ['tests/conditionHistoryRealPg.test.ts'],
  env: { JWT_SECRET: 'synthetic-condition-realpg-test-only' },
  fileParallelism: false, testTimeout: 15000, hookTimeout: 15000,
} });
