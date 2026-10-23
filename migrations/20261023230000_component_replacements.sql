-- Explicit positions are assigned only by a reviewed replacement operation.
CREATE TABLE component_positions (
 id UUID PRIMARY KEY, opening_id UUID NOT NULL REFERENCES openings(id),
 mounting_scope TEXT NOT NULL CHECK(mounting_scope IN ('opening','frame','door_leaf')),
 frame_id UUID, door_leaf_id UUID,
 component_type TEXT NOT NULL, position_key TEXT NOT NULL CHECK(length(trim(position_key)) BETWEEN 1 AND 120),
 UNIQUE(id,opening_id),
 CHECK((mounting_scope='opening' AND frame_id IS NULL AND door_leaf_id IS NULL) OR
 (mounting_scope='frame' AND frame_id IS NOT NULL AND door_leaf_id IS NULL) OR
 (mounting_scope='door_leaf' AND frame_id IS NULL AND door_leaf_id IS NOT NULL)),
 FOREIGN KEY(frame_id,opening_id) REFERENCES opening_frames(id,opening_id),
 FOREIGN KEY(door_leaf_id,opening_id) REFERENCES door_leaves(id,opening_id)
);
CREATE UNIQUE INDEX position_identity ON component_positions(opening_id,mounting_scope,COALESCE(frame_id,door_leaf_id,opening_id),component_type,position_key);
ALTER TABLE hardware_components ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN ('active','retired')),
 ADD COLUMN position_id UUID,
 ADD COLUMN supersedes_component_id UUID UNIQUE REFERENCES hardware_components(id);
ALTER TABLE hardware_components ADD CONSTRAINT component_position_opening FOREIGN KEY(position_id,opening_id) REFERENCES component_positions(id,opening_id);
CREATE UNIQUE INDEX position_current_component ON hardware_components(position_id) WHERE position_id IS NOT NULL AND lifecycle_state='active';
CREATE TABLE component_replacements (
 id UUID PRIMARY KEY, opening_id UUID NOT NULL REFERENCES openings(id),
 position_id UUID NOT NULL, predecessor_id UUID NOT NULL UNIQUE, successor_id UUID NOT NULL UNIQUE,
 evidence JSONB NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), recorded_by_user_id UUID NOT NULL REFERENCES users(id),
 FOREIGN KEY(position_id,opening_id) REFERENCES component_positions(id,opening_id),
 FOREIGN KEY(predecessor_id,opening_id) REFERENCES hardware_components(id,opening_id),
 FOREIGN KEY(successor_id,opening_id) REFERENCES hardware_components(id,opening_id),
 CHECK(predecessor_id<>successor_id)
);
CREATE FUNCTION protect_component_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p component_positions;
BEGIN
 IF TG_OP='UPDATE' AND OLD.lifecycle_state='retired' THEN RAISE EXCEPTION 'retired component is immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.position_id IS NOT NULL AND
  (NEW.position_id IS DISTINCT FROM OLD.position_id OR NEW.component_type<>OLD.component_type OR NEW.mounting_scope<>OLD.mounting_scope OR NEW.frame_id IS DISTINCT FROM OLD.frame_id OR NEW.door_leaf_id IS DISTINCT FROM OLD.door_leaf_id OR NEW.supersedes_component_id IS DISTINCT FROM OLD.supersedes_component_id)
 THEN RAISE EXCEPTION 'position identity is immutable'; END IF;
 IF NEW.position_id IS NOT NULL THEN
  SELECT * INTO p FROM component_positions WHERE id=NEW.position_id;
  IF p.opening_id IS DISTINCT FROM NEW.opening_id OR p.component_type IS DISTINCT FROM NEW.component_type OR p.mounting_scope IS DISTINCT FROM NEW.mounting_scope OR p.frame_id IS DISTINCT FROM NEW.frame_id OR p.door_leaf_id IS DISTINCT FROM NEW.door_leaf_id THEN RAISE EXCEPTION 'component position mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER component_lifecycle BEFORE INSERT OR UPDATE ON hardware_components FOR EACH ROW EXECUTE FUNCTION protect_component_lifecycle();
CREATE TRIGGER replacement_append_only BEFORE UPDATE OR DELETE ON component_replacements FOR EACH ROW EXECUTE FUNCTION protect_installation_history();
CREATE TRIGGER position_append_only BEFORE UPDATE OR DELETE ON component_positions FOR EACH ROW EXECUTE FUNCTION protect_installation_history();
-- Histories are exposed separately; only this view feeds current asset calculations.
CREATE VIEW current_hardware_components AS SELECT * FROM hardware_components WHERE lifecycle_state='active';
ALTER TABLE sync_operation_receipts DROP CONSTRAINT sync_operation_receipts_entity_type_check;
ALTER TABLE sync_operation_receipts ADD CONSTRAINT sync_operation_receipts_entity_type_check CHECK(entity_type IN ('opening','frame','door_leaf','component','photo','service_event','inspection_event','completion','purchasing_review','service_request','installation_fact','replacement'));
ALTER TABLE component_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_replacements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON component_positions,component_replacements,current_hardware_components FROM PUBLIC;
DO $$ DECLARE t TEXT; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON component_positions,component_replacements,current_hardware_components FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON component_positions,component_replacements,current_hardware_components FROM authenticated; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT ON current_hardware_components TO oi_pr2_api;
  GRANT SELECT,INSERT ON component_positions,component_replacements TO oi_pr2_api;
  FOREACH t IN ARRAY ARRAY['component_positions','component_replacements'] LOOP
   EXECUTE format('CREATE POLICY oi_pr2_api_select ON %I FOR SELECT TO oi_pr2_api USING(true)',t);
   EXECUTE format('CREATE POLICY oi_pr2_api_insert ON %I FOR INSERT TO oi_pr2_api WITH CHECK(true)',t);
  END LOOP;
 END IF;
END $$;
