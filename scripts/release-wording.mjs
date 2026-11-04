// Production-only wording. Staging and candidate sites keep their nonproduction labels.
export const PRODUCTION_SITE_ID = 'b4e0fc62-86ce-4a26-9ebf-26d7386f4b01';
export function isProductionRelease(env) {
  return env.NETLIFY === 'true' && env.CONTEXT === 'production' &&
    env.SITE_ID === PRODUCTION_SITE_ID && env.BRANCH === 'release/production';
}
const LANDING_TITLE = '<title>OI connected release validation</title>';
const LANDING_NOTICE = '<p>Private release candidate — acceptance pending. Synthetic testing only.</p>';
export function landingHtml(html, production) {
  if (!production) return html;
  for (const s of [LANDING_TITLE, LANDING_NOTICE]) if (!html.includes(s)) throw new Error('Landing page source changed: ' + s);
  return html.replace(LANDING_TITLE, '<title>Opening Intelligence</title>').replace(LANDING_NOTICE, '');
}
export function releaseInfo(production) {
  return production
    ? { environment: 'production', releaseStatus: 'production' }
    : { environment: 'isolated-release-validation', releaseStatus: 'acceptance-pending' };
}
