// Read-only check before the production schema bundle.
// Refuses the production and staging project refs. Does not write.
import { Client } from "pg";

const refused = /bekaxmatcvxqpjixwsqn|boaoedvyvifppuklbwad/i;
const url = process.env.DATABASE_URL || "";
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (refused.test(url)) {
  console.error("Refusing hosted production or staging database. Pre-check is for a local restore only.");
  process.exit(1);
}

const expectedPolicies = 69;
const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const policies = await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'prod_api_%'");
  const present = await client.query(`SELECT to_regclass('public.password_reset_tokens') AS resets,
    to_regclass('public.staff_mfa_factors') AS mfa,
    to_regclass('public.staff_sign_in_codes') AS codes,
    to_regclass('public.provider_accounts') AS accounts,
    to_regclass('public.inspection_visits') AS visits`);
  await client.query("ROLLBACK");
  const row = present.rows[0];
  const report = {
    prod_api_policies: policies.rows[0].n,
    password_reset_tokens: row.resets !== null,
    staff_mfa_factors: row.mfa !== null,
    staff_sign_in_codes: row.codes !== null,
    provider_accounts_absent: row.accounts === null,
    inspection_visits_absent: row.visits === null,
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = report.prod_api_policies === expectedPolicies
    && report.password_reset_tokens && report.staff_mfa_factors && report.staff_sign_in_codes
    && report.provider_accounts_absent && report.inspection_visits_absent;
  if (!ok) process.exitCode = 1;
} finally {
  await client.end();
}
