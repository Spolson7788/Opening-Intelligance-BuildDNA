import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/recognitionRelease.test.ts','tests/legacyVision.test.ts','tests/reportedReferenceHint.test.ts','tests/referenceCitationLayout.test.ts','tests/labelReading.test.ts','tests/partialMarkings.test.ts'],environment:'node',env:{JWT_SECRET:'local-release-test-only'}}});
