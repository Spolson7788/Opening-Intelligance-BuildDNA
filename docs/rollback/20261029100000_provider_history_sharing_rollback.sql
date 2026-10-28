-- Rollback for 20261029100000_provider_history_sharing.sql. Removing the column restores
-- the previous behaviour in the database; the a-series API code must be rolled back first,
-- because it reads this column.
ALTER TABLE public.properties DROP COLUMN IF EXISTS share_provider_service_history;
