import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({
  resolve:{alias:{'react-dom':resolve('field-app/node_modules/react-dom'),'react':resolve('field-app/node_modules/react'),'react-router-dom':resolve('field-app/node_modules/react-router-dom')}},
  define:{__PHOTO_ISOLATION_ENABLED__:'false'},
  test:{environment:'jsdom',environmentOptions:{jsdom:{url:'https://oi-connected-release-candidate.netlify.app/field/opening/test'}},include:['tests/captureAccess*.test.ts*','tests/measurementPhotoChoice.test.tsx']},
});
