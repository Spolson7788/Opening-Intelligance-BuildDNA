// Do not bootstrap this runner's ledger over an existing untracked database.
async function assertMigrationBaseline(client) {
  const result = await client.query(`SELECT
    to_regclass('public.schema_migrations') IS NOT NULL AS app_ledger,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname <> 'schema_migrations') AS existing_tables`);
  const state = result.rows[0];
  if (!state || (!state.app_ledger && state.existing_tables)) {
    throw new Error('Migration baseline requires reconciliation: existing public tables have no application migration ledger. No migrations were applied.');
  }
}
module.exports = { assertMigrationBaseline };
