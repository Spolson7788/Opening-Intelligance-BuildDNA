import { defineConfig } from 'vitest/config';
// No destructive globalSetup, migrations, server launch or external environment URLs.
export default defineConfig({ test: { environment:'node', include:['tests/estimatingBudgetRealPg.test.ts'],
  env:{JWT_SECRET:'synthetic-estimating-budget-local-only'},fileParallelism:false,testTimeout:15000,hookTimeout:15000 } });
