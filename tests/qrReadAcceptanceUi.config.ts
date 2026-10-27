import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({esbuild:{jsx:'automatic'},resolve:{alias:{'react-dom':resolve('dashboard/node_modules/react-dom'),'react':resolve('dashboard/node_modules/react')}},test:{environment:'jsdom',include:['tests/qrReadAcceptanceUi.test.tsx']}});
