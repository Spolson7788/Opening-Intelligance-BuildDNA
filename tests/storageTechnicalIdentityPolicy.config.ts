// Dedicated non-destructive local fixture; no global setup or hosted connection.
import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/storageTechnicalIdentityPolicy.test.ts'],fileParallelism:false,testTimeout:15000,hookTimeout:15000}});
