import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/retainedDocumentRecovery.test.ts','tests/retainedDocumentRecoveryRoute.test.ts','tests/retainedDocumentRecoveryUi.test.ts','tests/commercialUi.test.ts'],fileParallelism:false,testTimeout:20000,hookTimeout:30000}});
