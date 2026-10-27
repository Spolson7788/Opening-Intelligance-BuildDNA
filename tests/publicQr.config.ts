import { defineConfig } from 'vitest/config';
export default defineConfig({test:{env:{JWT_SECRET:'synthetic-public-qr-test-only'},include:['tests/publicQr.test.ts']}});
