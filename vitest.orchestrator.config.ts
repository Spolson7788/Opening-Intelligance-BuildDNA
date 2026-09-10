import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/orchestrator/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 5000,
  },
});
