import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/videoQrParser.test.ts', 'tests/videoLabelUi.test.ts', 'tests/videoRequestOffline.test.ts', 'tests/videoRequestWizard.test.ts'] } });
