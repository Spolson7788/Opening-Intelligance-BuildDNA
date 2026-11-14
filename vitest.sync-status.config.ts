import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({resolve:{alias:{'html5-qrcode':resolve('field-app/node_modules/html5-qrcode'),'react-router-dom':resolve('field-app/node_modules/react-router-dom'),'react-dom':resolve('field-app/node_modules/react-dom'),'react':resolve('field-app/node_modules/react')}},test:{environment:'jsdom',include:['tests/syncStatusUi.test.tsx','tests/accountIdentityRefresh.test.tsx','tests/logoutProgress.test.tsx','tests/accountHeaderUi.test.tsx','tests/inspectionPhotoUi.test.tsx']}});
