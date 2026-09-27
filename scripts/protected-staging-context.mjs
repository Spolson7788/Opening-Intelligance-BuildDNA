// Keep preview approval narrow: one existing nonproduction site, its staging
// branch, or the reviewed company/territory pull request. Never production.
export function assertProtectedStagingContext(env) {
  if (env.NETLIFY !== 'true') return;
  const correctSite = env.SITE_ID === '6430c57d-8a98-43bc-ba25-94007dd244f2';
  const staging = env.CONTEXT === 'branch-deploy' && env.BRANCH === 'pr2-staging';
  const territoryPreview = env.CONTEXT === 'deploy-preview' &&
    env.HEAD === 'feat/field-territory-integration' && env.REVIEW_ID === '9';
  if (!correctSite || (!staging && !territoryPreview)) {
    throw new Error('Build requires the protected nonproduction site and an approved staging context: ' + JSON.stringify({site:env.SITE_ID,context:env.CONTEXT,branch:env.BRANCH,head:env.HEAD,review:env.REVIEW_ID}));
  }
}
