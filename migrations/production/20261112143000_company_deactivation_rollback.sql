-- Rolls back the company-deactivation addendum on a local restore.
-- Does not delete companies, memberships, facilities, openings, photos, or assignments.
-- Refuses when a company deactivation audit row exists.

BEGIN;

\ir ../../docs/rollback/20261112143000_company_deactivation_rollback.sql

DELETE FROM public.schema_migrations WHERE filename = '20261112143000_company_deactivation.sql';

COMMIT;
