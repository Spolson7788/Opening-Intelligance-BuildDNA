import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({
  resolve:{alias:{'react-dom':resolve('dashboard/node_modules/react-dom'),'react':resolve('dashboard/node_modules/react')}},
  test:{environment:'jsdom',environmentOptions:{jsdom:{url:'https://oi-video-workflows-staging.netlify.app/dashboard/staging-storage-comparison'}},include:['tests/stagingStorageDiagnosticUI.test.tsx']},
});
