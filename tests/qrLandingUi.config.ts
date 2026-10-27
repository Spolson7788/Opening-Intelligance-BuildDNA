import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({define:{__PHOTO_ISOLATION_ENABLED__:'false'},resolve:{alias:{'react-router-dom':resolve('field-app/node_modules/react-router-dom'),'react-dom':resolve('field-app/node_modules/react-dom'),'react':resolve('field-app/node_modules/react')}},test:{environment:'jsdom',include:['tests/qrLandingUi.test.tsx','tests/loginAuthenticatedUi.test.tsx','tests/videoQrParser.test.ts','tests/openingQr.test.ts']}});
