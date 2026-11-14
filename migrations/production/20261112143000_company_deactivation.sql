-- Addendum to the r59 production bundle. Apply only on a local restore, after
-- migrations/production/20261112140500_r59_production_schema.sql.
-- Do not run against a hosted database from this repository commit.
-- One transaction. Does not delete company data.

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE filename = '20261112143000_company_deactivation.sql') THEN
    RAISE EXCEPTION 'company_deactivation_already_applied';
  END IF;
END $$;

\ir ../20261112143000_company_deactivation.sql

INSERT INTO public.schema_migrations (filename)
SELECT '20261112143000_company_deactivation.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE filename = '20261112143000_company_deactivation.sql'
);

COMMIT;
