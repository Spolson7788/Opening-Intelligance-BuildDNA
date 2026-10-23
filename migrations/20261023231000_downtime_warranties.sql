CREATE TABLE lifecycle_records (
 id UUID PRIMARY KEY, opening_id UUID NOT NULL REFERENCES openings(id),
 kind TEXT NOT NULL CHECK(kind IN ('downtime','warranty')),
 payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
 correction_of UUID UNIQUE, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 recorded_by_user_id UUID NOT NULL REFERENCES users(id),
 UNIQUE(id,opening_id,kind), UNIQUE(id,opening_id),
 FOREIGN KEY(correction_of,opening_id,kind) REFERENCES lifecycle_records(id,opening_id,kind)
);
CREATE TABLE lifecycle_record_components (
 record_id UUID NOT NULL, component_id UUID NOT NULL,
 opening_id UUID NOT NULL, PRIMARY KEY(record_id,component_id),
 FOREIGN KEY(component_id,opening_id) REFERENCES hardware_components(id,opening_id),
 FOREIGN KEY(record_id,opening_id) REFERENCES lifecycle_records(id,opening_id)
);
CREATE INDEX lifecycle_records_opening ON lifecycle_records(opening_id,recorded_at,id);
CREATE TRIGGER lifecycle_record_append_only BEFORE UPDATE OR DELETE ON lifecycle_records FOR EACH ROW EXECUTE FUNCTION protect_installation_history();
CREATE TRIGGER lifecycle_target_append_only BEFORE UPDATE OR DELETE ON lifecycle_record_components FOR EACH ROW EXECUTE FUNCTION protect_installation_history();
ALTER TABLE sync_operation_receipts DROP CONSTRAINT sync_operation_receipts_entity_type_check;
ALTER TABLE sync_operation_receipts ADD CONSTRAINT sync_operation_receipts_entity_type_check CHECK(entity_type IN ('opening','frame','door_leaf','component','photo','service_event','inspection_event','completion','purchasing_review','service_request','installation_fact','replacement','downtime','warranty'));
ALTER TABLE lifecycle_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_record_components ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON lifecycle_records,lifecycle_record_components FROM PUBLIC;
DO $$ DECLARE t TEXT; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON lifecycle_records,lifecycle_record_components FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON lifecycle_records,lifecycle_record_components FROM authenticated; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT,INSERT ON lifecycle_records,lifecycle_record_components TO oi_pr2_api;
  FOREACH t IN ARRAY ARRAY['lifecycle_records','lifecycle_record_components'] LOOP
   EXECUTE format('CREATE POLICY oi_pr2_api_select ON %I FOR SELECT TO oi_pr2_api USING(true)',t);
   EXECUTE format('CREATE POLICY oi_pr2_api_insert ON %I FOR INSERT TO oi_pr2_api WITH CHECK(true)',t);
  END LOOP;
 END IF;
END $$;
