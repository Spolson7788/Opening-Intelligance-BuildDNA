import {assertReferenceStagingDatabase} from './reference/preview-context.mjs';
export function assertIsolatedReleaseContext(env) {
  const referencePreview = env.NETLIFY === 'true' && env.SITE_ID === '80fbbee8-b9d3-4b16-b93f-d2d8396591ec' && ['deploy-preview','branch-deploy'].includes(env.CONTEXT) && (env.HEAD || env.BRANCH) === 'feat/reference-evidence-os6';
  if (referencePreview) { assertReferenceStagingDatabase(env); return; }
  if (env.NETLIFY !== 'true' || env.SITE_ID !== '80fbbee8-b9d3-4b16-b93f-d2d8396591ec' ||
      env.CONTEXT !== 'production' || env.BRANCH !== 'release/connected-candidate') {
    throw new Error('Isolated release build requires its exact private site, production context and release branch.');
  }
}
