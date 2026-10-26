import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/commercialLocal.test.ts'],fileParallelism:false,hookTimeout:60000,testTimeout:20000,env:{JWT_SECRET:'synthetic-commercial-local-only',CORS_ORIGINS:''}}});
