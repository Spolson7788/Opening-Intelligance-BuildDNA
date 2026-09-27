import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/recognitionRelease.test.ts'],environment:'node',env:{JWT_SECRET:'local-release-test-only'}}});
