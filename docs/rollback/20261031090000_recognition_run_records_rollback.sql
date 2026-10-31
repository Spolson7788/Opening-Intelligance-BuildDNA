-- Rollback for DRAFT 20261031090000_recognition_run_records.sql. Removes the per-attempt records and
-- the record outbox (recognition_runs and usage counters are untouched); take an export first.
DROP VIEW IF EXISTS recognition_run_records_monthly;
-- If the optional pg_cron job (docs/scheduled/) was enabled, first run: SELECT cron.unschedule('oi-recognition-record-outbox-reprocess');
DROP TABLE IF EXISTS recognition_access_denials;
DROP FUNCTION IF EXISTS recognition_access_denials_guard();
DROP FUNCTION IF EXISTS recognition_run_record_outbox_reprocess(INTEGER);
DROP FUNCTION IF EXISTS recognition_run_records_write(JSONB, BOOLEAN, NUMERIC);
DROP TABLE IF EXISTS recognition_run_record_outbox;
DROP TABLE IF EXISTS recognition_run_records;
DROP FUNCTION IF EXISTS recognition_run_record_visible(UUID, UUID);
DROP FUNCTION IF EXISTS recognition_run_records_guard();
DROP FUNCTION IF EXISTS recognition_run_record_outbox_guard();