-- UNDO for migrations/20261028150000_schedule_comparison_snapshots.sql (M4).
-- Removes the snapshot table, its triggers and functions. Nothing else depends
-- on it. Refuses to run if any snapshot exists (saved reports would be lost);
-- in that case export schedule_comparison_snapshots first and get approval.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM schedule_comparison_snapshots) THEN
  RAISE EXCEPTION 'schedule_comparison_snapshots has rows: export them and get approval before undo';
 END IF;
END $$;
DROP TRIGGER schedule_comparison_snapshots_check ON schedule_comparison_snapshots;
DROP TRIGGER schedule_comparison_snapshots_no_change ON schedule_comparison_snapshots;
DROP TABLE schedule_comparison_snapshots;
DROP FUNCTION schedule_comparison_snapshots_check();
DROP FUNCTION schedule_comparison_snapshots_immutable();
DELETE FROM schema_migrations WHERE filename='20261028150000_schedule_comparison_snapshots.sql';
COMMIT;