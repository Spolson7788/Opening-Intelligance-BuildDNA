import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/storageTechnicalIdentity.test.ts','tests/supabaseCommercialStorage.test.ts','tests/storageVerification.test.ts','tests/stagingInputRuntime.test.ts']}});
