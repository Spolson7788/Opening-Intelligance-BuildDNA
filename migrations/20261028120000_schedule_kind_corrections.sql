-- M3B: correct a schedule's type (door <-> hardware) and archive / unarchive a
-- schedule. Additive only: two nullable columns on facility_schedules, one new
-- append-only event table, guard triggers. No existing row is changed.
--
-- Rules enforced here (the API enforces the same and returns friendly errors):
--  * kind may change only if NO confirmed schedule import uses any version of
--    the schedule. Draft imports are allowed; they become stale (derived from
--    the event table, no change to schedule_imports) and cannot be confirmed.
--  * every kind change / archive / unarchive needs a matching event row written
--    in the same transaction (created_at = now()). Events are immutable.
--  * archived schedules keep all versions and history; archive is reversible.
-- Undo: docs/rollback/20261028120000_schedule_kind_corrections_rollback.sql
ALTER TABLE facility_schedules ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE facility_schedules ADD COLUMN archived_by_user_id UUID REFERENCES users(id);
ALTER TABLE facility_schedules ADD CONSTRAINT facility_schedules_archive_pair
 CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL));

CREATE TABLE facility_schedule_events (
 id UUID PRIMARY KEY,
 schedule_id UUID NOT NULL REFERENCES facility_schedules(id),
 event TEXT NOT NULL CHECK (event IN ('kind_changed','archived','unarchived')),
 from_kind TEXT CHECK (from_kind IN ('door','hardware')),
 to_kind TEXT CHECK (to_kind IN ('door','hardware')),
 reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
 mismatch_acknowledged BOOLEAN NOT NULL DEFAULT false,
 actor_user_id UUID NOT NULL REFERENCES users(id),
 actor_organization_id UUID NOT NULL REFERENCES organizations(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((event = 'kind_changed') = (from_kind IS NOT NULL AND to_kind IS NOT NULL AND from_kind <> to_kind)),
 CHECK (event <> 'kind_changed' OR reason IS NOT NULL)
);
CREATE INDEX facility_schedule_events_schedule ON facility_schedule_events(schedule_id, created_at);

CREATE FUNCTION facility_schedule_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'facility_schedule_events are append-only';
END $$;
CREATE TRIGGER facility_schedule_events_no_change
 BEFORE UPDATE OR DELETE ON facility_schedule_events
 FOR EACH ROW EXECUTE FUNCTION facility_schedule_events_immutable();

CREATE FUNCTION facility_schedules_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.property_id <> OLD.property_id OR NEW.created_by_organization_id <> OLD.created_by_organization_id
    OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at OR NEW.title <> OLD.title THEN
  RAISE EXCEPTION 'facility_schedules identity columns are immutable';
 END IF;
 IF NEW.kind <> OLD.kind THEN
  IF EXISTS (SELECT 1 FROM schedule_imports i JOIN facility_schedule_versions v ON v.id IN (i.door_version_id, i.hardware_version_id)
             WHERE v.schedule_id = OLD.id AND i.status = 'confirmed') THEN
   RAISE EXCEPTION 'schedule kind cannot change: used by a confirmed import';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM facility_schedule_events e WHERE e.schedule_id = OLD.id AND e.event = 'kind_changed'
                 AND e.from_kind = OLD.kind AND e.to_kind = NEW.kind AND e.created_at = now()) THEN
   RAISE EXCEPTION 'schedule kind change requires a kind_changed event in the same transaction';
  END IF;
 END IF;
 IF NEW.archived_at IS DISTINCT FROM OLD.archived_at OR NEW.archived_by_user_id IS DISTINCT FROM OLD.archived_by_user_id THEN
  IF NOT EXISTS (SELECT 1 FROM facility_schedule_events e WHERE e.schedule_id = OLD.id AND e.created_at = now()
                 AND e.event = CASE WHEN NEW.archived_at IS NULL THEN 'unarchived' ELSE 'archived' END) THEN
   RAISE EXCEPTION 'schedule archive change requires an archive event in the same transaction';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER facility_schedules_kind_guard
 BEFORE UPDATE ON facility_schedules
 FOR EACH ROW EXECUTE FUNCTION facility_schedules_change_guard();

ALTER TABLE facility_schedule_events ENABLE ROW LEVEL SECURITY;