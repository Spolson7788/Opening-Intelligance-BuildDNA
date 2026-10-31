-- OPTIONAL SCHEDULER for the recognition run record outbox. NOT a migration and NOT APPLIED
-- anywhere (it lives outside migrations/ on purpose). Enabling it on staging or production needs
-- Stephan's separate deploy approval.
-- Requires: migration 20261031090000_recognition_run_records.sql applied, and the pg_cron
-- extension (Supabase: Dashboard > Database > Extensions > pg_cron, or the statement below).
-- Runs every 5 minutes, at most 200 entries per run. Safe if runs overlap or the staff endpoint
-- (POST /api/platform/recognition-run-records/outbox/reprocess) runs at the same time:
-- recognition_run_record_outbox_reprocess() takes entries FOR UPDATE SKIP LOCKED and writes are
-- idempotent on (attempt_id, photo_slot). Entries are never deleted.
CREATE EXTENSION IF NOT EXISTS pg_cron;
-- cron.schedule with a job name updates the job if it already exists (re-running this is safe).
SELECT cron.schedule('oi-recognition-record-outbox-reprocess', '*/5 * * * *',
  $job$SELECT * FROM public.recognition_run_record_outbox_reprocess(200)$job$);
-- Check:   SELECT jobid, schedule, active FROM cron.job WHERE jobname = 'oi-recognition-record-outbox-reprocess';
--          SELECT status, return_message, start_time FROM cron.job_run_details
--            WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'oi-recognition-record-outbox-reprocess') ORDER BY start_time DESC LIMIT 20;
-- Pause:   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'oi-recognition-record-outbox-reprocess'), active := false);
-- Disable: SELECT cron.unschedule('oi-recognition-record-outbox-reprocess');
