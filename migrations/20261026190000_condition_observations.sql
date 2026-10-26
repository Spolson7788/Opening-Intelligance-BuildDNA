-- Additive evidence history only: no current-condition updates or inferred backfill.
-- Deliberately NO role grants/policies. API-role access requires separate review.
CREATE TABLE condition_observations (
 id UUID PRIMARY KEY,
 opening_id UUID NOT NULL REFERENCES openings(id),
 target_type TEXT NOT NULL CHECK(target_type IN ('frame','door_leaf','component')),
 target_id UUID NOT NULL,
 frame_id UUID, door_leaf_id UUID, hardware_component_id UUID,
 condition TEXT NOT NULL CHECK(condition IN ('good','worn','failed','unverified')),
 certainty TEXT NOT NULL CHECK(certainty IN ('confirmed','estimated','unknown')),
 precision TEXT NOT NULL CHECK(precision IN ('day','month','year','unknown')),
 year INTEGER, month INTEGER, day INTEGER,
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 2000),
 note TEXT NOT NULL CHECK(length(note)<=4000),
 target_snapshot JSONB NOT NULL CHECK(jsonb_typeof(target_snapshot)='object'),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 recorded_by_user_id UUID NOT NULL REFERENCES users(id),
 recording_organization_id UUID NOT NULL REFERENCES organizations(id),
 correction_of UUID UNIQUE,
 correction_reason TEXT NOT NULL CHECK(length(correction_reason)<=2000),
 UNIQUE(id,opening_id,target_type,target_id),
 CHECK(num_nonnulls(frame_id,door_leaf_id,hardware_component_id)=1),
 CHECK((target_type='frame' AND frame_id IS NOT NULL AND target_id=frame_id)
    OR (target_type='door_leaf' AND door_leaf_id IS NOT NULL AND target_id=door_leaf_id)
    OR (target_type='component' AND hardware_component_id IS NOT NULL AND target_id=hardware_component_id)),
 CHECK((certainty='unknown' AND precision='unknown' AND year IS NULL AND month IS NULL AND day IS NULL)
   OR (certainty<>'unknown' AND year BETWEEN 1 AND 9999 AND year IS NOT NULL AND
     ((precision='year' AND month IS NULL AND day IS NULL) OR
      (precision='month' AND month BETWEEN 1 AND 12 AND month IS NOT NULL AND day IS NULL) OR
      (precision='day' AND month BETWEEN 1 AND 12 AND month IS NOT NULL AND day BETWEEN 1 AND 31 AND day IS NOT NULL)))),
 CHECK(precision<>'day' OR make_date(year,month,day) IS NOT NULL),
 CHECK((correction_of IS NULL AND correction_reason='') OR
       (correction_of IS NOT NULL AND correction_of<>id AND length(trim(correction_reason))>0)),
 FOREIGN KEY(correction_of,opening_id,target_type,target_id) REFERENCES condition_observations(id,opening_id,target_type,target_id),
 FOREIGN KEY(frame_id,opening_id) REFERENCES opening_frames(id,opening_id),
 FOREIGN KEY(door_leaf_id,opening_id) REFERENCES door_leaves(id,opening_id),
 FOREIGN KEY(hardware_component_id,opening_id) REFERENCES hardware_components(id,opening_id)
);
CREATE INDEX condition_observations_opening ON condition_observations(opening_id,recorded_at,id);
CREATE TRIGGER condition_observations_append_only BEFORE UPDATE OR DELETE ON condition_observations
 FOR EACH ROW EXECUTE FUNCTION protect_installation_history();
ALTER TABLE condition_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_operation_receipts DROP CONSTRAINT sync_operation_receipts_entity_type_check;
ALTER TABLE sync_operation_receipts ADD CONSTRAINT sync_operation_receipts_entity_type_check CHECK(entity_type IN ('opening','frame','door_leaf','component','photo','service_event','inspection_event','completion','purchasing_review','service_request','installation_fact','replacement','downtime','warranty','condition_observation'));
