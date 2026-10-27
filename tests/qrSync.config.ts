import {defineConfig} from 'vitest/config';
export default defineConfig({define:{__PHOTO_ISOLATION_ENABLED__:'false'},test:{environment:'node',include:['tests/offlineFlushRecovery.test.ts','tests/principalChangeRecovery.test.ts','tests/videoRequestOffline.test.ts','tests/qrPhotoPause.test.ts']}});
