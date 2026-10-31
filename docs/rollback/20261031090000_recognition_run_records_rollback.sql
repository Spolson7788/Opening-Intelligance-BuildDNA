-- Rollback for DRAFT 20261031090000_recognition_run_records.sql. Removes the per-attempt records and
-- the record outbox (recognition_runs and usage counters are untouched); take an export first.
DROP VIEW IF EXISTS recognition_run_records_monthly;
DROP TABLE IF EXISTS recognition_run_record_outbox;
DROP TABLE IF EXISTS recognition_run_records;
DROP FUNCTION IF EXISTS recognition_run_record_visible(UUID, UUID);
DROP FUNCTION IF EXISTS recognition_run_records_guard();
DROP FUNCTION IF EXISTS recognition_run_record_outbox_guard();