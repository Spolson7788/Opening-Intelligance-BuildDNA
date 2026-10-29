-- Rollback for DRAFT 20261030090700_recognition_runs.sql. Removes run history; take an export first.
DROP TABLE IF EXISTS recognition_run_photos;
DROP TABLE IF EXISTS recognition_runs;
DROP FUNCTION IF EXISTS recognition_run_photos_guard();
DROP FUNCTION IF EXISTS recognition_runs_guard();
