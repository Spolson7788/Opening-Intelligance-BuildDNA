import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/accessStatusUi.test.ts','tests/commercialUi.test.ts','tests/financeExport.test.ts','tests/planningExport.test.ts']}});
