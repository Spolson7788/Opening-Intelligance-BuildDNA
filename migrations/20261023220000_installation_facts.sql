-- Installation facts are additive. Legacy install_date remains untouched/unreviewed.
CREATE TABLE installation_facts (
 id UUID PRIMARY KEY,
 opening_id UUID NOT NULL REFERENCES openings(id),
 frame_id UUID, door_leaf_id UUID, hardware_component_id UUID,
 certainty TEXT NOT NULL CHECK(certainty IN ('confirmed','estimated','unknown')),
 precision TEXT NOT NULL CHECK(precision IN ('day','month','year','unknown')),
 year INTEGER, month INTEGER, day INTEGER,
 source_type TEXT NOT NULL CHECK(source_type IN ('installation_record','maintenance_log','invoice','provider','recollection','unknown')),
 source_reference TEXT NOT NULL,
 note TEXT NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 recorded_by_user_id UUID NOT NULL REFERENCES users(id),
 recording_organization_id UUID NOT NULL REFERENCES organizations(id),
 correction_of UUID UNIQUE,
 correction_reason TEXT NOT NULL,
 UNIQUE(id,opening_id),
 CHECK(num_nonnulls(frame_id,door_leaf_id,hardware_component_id)<=1),
 CHECK((certainty='unknown' AND precision='unknown' AND year IS NULL AND month IS NULL AND day IS NULL)
   OR (certainty<>'unknown' AND year BETWEEN 1 AND 9999 AND year IS NOT NULL AND
     ((precision='year' AND month IS NULL AND day IS NULL) OR
      (precision='month' AND month BETWEEN 1 AND 12 AND month IS NOT NULL AND day IS NULL) OR
      (precision='day' AND month BETWEEN 1 AND 12 AND month IS NOT NULL AND day BETWEEN 1 AND 31 AND day IS NOT NULL)))),
 CHECK(precision<>'day' OR make_date(year,month,day) IS NOT NULL),
 CHECK(certainty<>'confirmed' OR (source_type NOT IN ('unknown','recollection') AND length(trim(source_reference))>0)),
 CHECK((correction_of IS NULL AND correction_reason='') OR (correction_of IS NOT NULL AND length(trim(correction_reason))>0)),
 FOREIGN KEY(correction_of,opening_id) REFERENCES installation_facts(id,opening_id),
 FOREIGN KEY(frame_id,opening_id) REFERENCES opening_frames(id,opening_id),
 FOREIGN KEY(door_leaf_id,opening_id) REFERENCES door_leaves(id,opening_id),
 FOREIGN KEY(hardware_component_id,opening_id) REFERENCES hardware_components(id,opening_id)
);
-- Only one initial installation fact per instance/target. Corrections chain from it.
CREATE UNIQUE INDEX installation_root ON installation_facts(opening_id,(CASE WHEN frame_id IS NOT NULL THEN 'frame' WHEN door_leaf_id IS NOT NULL THEN 'door_leaf' WHEN hardware_component_id IS NOT NULL THEN 'component' ELSE 'opening' END),COALESCE(frame_id,door_leaf_id,hardware_component_id,opening_id)) WHERE correction_of IS NULL;
CREATE INDEX installation_opening ON installation_facts(opening_id,recorded_at,id);
CREATE FUNCTION protect_installation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'installation history is append-only'; END $$;
CREATE TRIGGER installation_append_only BEFORE UPDATE OR DELETE ON installation_facts FOR EACH ROW EXECUTE FUNCTION protect_installation_history();
ALTER TABLE sync_operation_receipts DROP CONSTRAINT sync_operation_receipts_entity_type_check;
ALTER TABLE sync_operation_receipts ADD CONSTRAINT sync_operation_receipts_entity_type_check CHECK(entity_type IN ('opening','frame','door_leaf','component','photo','service_event','inspection_event','completion','purchasing_review','service_request','installation_fact'));
ALTER TABLE installation_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON installation_facts FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON installation_facts FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON installation_facts FROM authenticated; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT,INSERT ON installation_facts TO oi_pr2_api;
  CREATE POLICY oi_pr2_api_select ON installation_facts FOR SELECT TO oi_pr2_api USING(true);
  CREATE POLICY oi_pr2_api_insert ON installation_facts FOR INSERT TO oi_pr2_api WITH CHECK(true);
 END IF;
END $$;

