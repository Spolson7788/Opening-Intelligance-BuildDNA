import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/identityConfirmationHistory.test.ts','tests/recognitionStabilityBudget.test.ts'],environment:'node',testTimeout:15000}});
