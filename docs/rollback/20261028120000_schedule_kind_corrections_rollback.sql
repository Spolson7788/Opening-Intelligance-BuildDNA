-- UNDO for migrations/20261028120000_schedule_kind_corrections.sql (M3B).
-- Removes the guard trigger, the event table and the two archive columns.
-- Refuses to run if any event was recorded (that history would be lost); in
-- that case export facility_schedule_events first and get separate approval.
-- Kind values already corrected are NOT reverted (they are valid door/hardware
-- values either way); archived schedules simply become visible again.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM facility_schedule_events) THEN
  RAISE EXCEPTION 'facility_schedule_events has rows: export them and get approval before undo';
 END IF;
END $$;
DROP TRIGGER facility_schedules_kind_guard ON facility_schedules;
DROP FUNCTION facility_schedules_change_guard();
DROP TRIGGER facility_schedule_events_no_change ON facility_schedule_events;
DROP TABLE facility_schedule_events;
DROP FUNCTION facility_schedule_events_immutable();
ALTER TABLE facility_schedules DROP CONSTRAINT facility_schedules_archive_pair;
ALTER TABLE facility_schedules DROP COLUMN archived_by_user_id;
ALTER TABLE facility_schedules DROP COLUMN archived_at;
DELETE FROM schema_migrations WHERE filename='20261028120000_schedule_kind_corrections.sql';
COMMIT;