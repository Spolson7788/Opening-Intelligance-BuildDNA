import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({resolve:{alias:{'react-dom':resolve('field-app/node_modules/react-dom'),'react':resolve('field-app/node_modules/react')}},define:{__PHOTO_ISOLATION_ENABLED__:'true'},test:{
  environment:'jsdom',environmentOptions:{jsdom:{url:'https://oi-connected-release-candidate.netlify.app/field/diagnostics/photo-isolation'}},
  include:['tests/photoDiagnostic.test.tsx'],
}});
