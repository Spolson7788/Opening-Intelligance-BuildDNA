import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', include: ['tests/conditionHistory.test.ts'],
  env: { JWT_SECRET: 'synthetic-condition-history-test-only' },
  fileParallelism: false, testTimeout: 15000, hookTimeout: 60000,
} });
