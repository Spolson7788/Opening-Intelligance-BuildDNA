export function assertIsolatedReleaseContext(env) {
  const approvedPair =
    (env.SITE_ID === '80fbbee8-b9d3-4b16-b93f-d2d8396591ec' && env.BRANCH === 'release/connected-candidate') ||
    (env.SITE_ID === 'b64bf33c-a131-4ae2-b2b0-9aec16e9f77b' && env.BRANCH === 'release/video-workflows-staging') ||
    (env.SITE_ID === 'b4e0fc62-86ce-4a26-9ebf-26d7386f4b01' && env.BRANCH === 'release/production');
  if (env.NETLIFY !== 'true' || env.CONTEXT !== 'production' || !approvedPair) {
    throw new Error('Isolated release build requires its exact private site, production context and release branch.');
  }
}
