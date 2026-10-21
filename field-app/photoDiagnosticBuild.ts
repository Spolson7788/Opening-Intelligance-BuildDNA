export function photoIsolationBuildEnabled(env:Record<string,string|undefined>) {
  return env.NETLIFY === 'true' && env.SITE_ID === '80fbbee8-b9d3-4b16-b93f-d2d8396591ec' &&
    env.CONTEXT === 'production' && (env.BRANCH || env.HEAD) === 'release/connected-candidate';
}
