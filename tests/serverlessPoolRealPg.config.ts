import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/serverlessPoolRealPg.test.ts'],fileParallelism:false,testTimeout:15000}});
