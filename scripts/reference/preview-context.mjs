export function assertReferenceStagingDatabase(env) {
  const expected = env.OI_REFERENCE_STAGING_PROJECT_REF;
  if (!/^[a-z0-9]{20}$/.test(expected || '')) throw new Error('Reference preview requires its staging project configuration.');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('Reference preview requires a staging database connection.'); }
  const direct = url.hostname === `db.${expected}.supabase.co`;
  const pooler = /^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && decodeURIComponent(url.username).endsWith('.' + expected);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !pooler)) throw new Error('Reference preview database does not match its designated staging project.');
}

export function requireReferenceStagingRuntime(context, databaseUrl, envGet) {
  if (!['deploy-preview', 'branch-deploy'].includes(context?.deploy?.context)) return;
  assertReferenceStagingDatabase({ DATABASE_URL: databaseUrl, OI_REFERENCE_STAGING_PROJECT_REF: envGet?.('OI_REFERENCE_STAGING_PROJECT_REF') });
}
