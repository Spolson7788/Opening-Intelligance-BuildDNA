-- Append-only recognition confirmations, including shadow-mode acknowledgments.
CREATE TABLE identity_confirmations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 run_id uuid NOT NULL REFERENCES recognition_runs(id),
 hardware_component_id uuid NOT NULL REFERENCES hardware_components(id),
 acknowledged_by uuid NOT NULL REFERENCES users(id),
 acknowledged_at timestamptz NOT NULL,
 manufacturer text NOT NULL,model text NOT NULL,series text,
 series_basis text,
 provenance text NOT NULL CHECK(provenance IN ('ai_seen_accepted','ai_seen_corrected')),
 shown_suggestion jsonb NOT NULL,
 supersedes_id uuid REFERENCES identity_confirmations(id),
 UNIQUE(hardware_component_id,acknowledged_at)
);
CREATE INDEX identity_confirmations_run_idx ON identity_confirmations(run_id);
ALTER TABLE identity_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity_confirmations FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON identity_confirmations FROM anon; END IF; IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON identity_confirmations FROM authenticated; END IF; END $$;

CREATE TABLE recognition_miss_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 confirmation_id uuid NOT NULL REFERENCES identity_confirmations(id),
 run_id uuid NOT NULL REFERENCES recognition_runs(id),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 field text NOT NULL CHECK(field IN ('manufacturer','series','model')),
 outcome text NOT NULL CHECK(outcome IN ('wrong','abstain','conflict')),
 expected text NOT NULL,actual text,
 status text NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','reviewed','resolved')),
 reviewer_role text NOT NULL DEFAULT 'admin',
 reviewer_id uuid REFERENCES users(id),
 proposed_fix text,
 UNIQUE(confirmation_id,field)
);
CREATE INDEX recognition_miss_queue_run_idx ON recognition_miss_queue(run_id);
ALTER TABLE recognition_miss_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON recognition_miss_queue FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON recognition_miss_queue FROM anon; END IF; IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON recognition_miss_queue FROM authenticated; END IF; END $$;

CREATE FUNCTION capture_identity_confirmation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r recognition_runs%ROWTYPE;prev uuid;cid uuid;derived_series text;field_name text;expected_value text;actual_value text;read_state text;
BEGIN
 IF NEW.identity_status<>'established' OR NEW.identity_acknowledged_by IS NULL OR NEW.identity_acknowledged_at IS NULL OR NEW.identity_recognition_run_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO r FROM recognition_runs WHERE id=NEW.identity_recognition_run_id AND opening_id=NEW.opening_id AND user_id=NEW.identity_acknowledged_by;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid_confirmation_run'; END IF;
 IF EXISTS(SELECT 1 FROM identity_confirmations WHERE hardware_component_id=NEW.id AND acknowledged_at=NEW.identity_acknowledged_at) THEN RETURN NEW; END IF;
 SELECT id INTO prev FROM identity_confirmations WHERE hardware_component_id=NEW.id ORDER BY acknowledged_at DESC,id DESC LIMIT 1;
 SELECT c->>'series' INTO derived_series FROM jsonb_array_elements(COALESCE(r.stage_one->'catalog_identity_review'->'candidates','[]')) c WHERE lower(c->>'manufacturer')=lower(NEW.manufacturer) AND lower(c->>'model')=lower(NEW.model_number) LIMIT 1;
 INSERT INTO identity_confirmations(organization_id,run_id,hardware_component_id,acknowledged_by,acknowledged_at,manufacturer,model,series,series_basis,provenance,shown_suggestion,supersedes_id)
 VALUES(r.organization_id,r.id,NEW.id,NEW.identity_acknowledged_by,NEW.identity_acknowledged_at,NEW.manufacturer,NEW.model_number,derived_series,CASE WHEN derived_series IS NOT NULL THEN 'catalog_row' END,
 CASE WHEN lower(COALESCE(r.suggestion->>'manufacturer',''))=lower(NEW.manufacturer) AND lower(COALESCE(r.suggestion->>'model',''))=lower(NEW.model_number) THEN 'ai_seen_accepted' ELSE 'ai_seen_corrected' END,r.suggestion,prev) RETURNING id INTO cid;
 FOREACH field_name IN ARRAY ARRAY['manufacturer','series','model'] LOOP
 expected_value:=CASE field_name WHEN 'manufacturer' THEN NEW.manufacturer WHEN 'series' THEN derived_series ELSE NEW.model_number END;
 actual_value:=r.suggestion->>field_name;
 IF expected_value IS NOT NULL AND lower(COALESCE(actual_value,''))<>lower(expected_value) THEN
 read_state:=CASE WHEN r.stage_one->'catalog_identity_review'->>'status' IN ('CONFLICT','TYPE_CONFLICT') THEN 'conflict' WHEN COALESCE(actual_value,'')='' THEN 'abstain' ELSE 'wrong' END;
 INSERT INTO recognition_miss_queue(confirmation_id,run_id,organization_id,field,outcome,expected,actual) VALUES(cid,r.id,r.organization_id,field_name,read_state,expected_value,actual_value);
 END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION capture_identity_confirmation() FROM PUBLIC;
CREATE TRIGGER capture_identity_confirmation AFTER INSERT OR UPDATE ON hardware_components FOR EACH ROW EXECUTE FUNCTION capture_identity_confirmation();
CREATE FUNCTION reject_confirmation_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'identity_confirmation_is_append_only'; END $$;
REVOKE ALL ON FUNCTION reject_confirmation_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_identity_confirmation BEFORE UPDATE OR DELETE ON identity_confirmations FOR EACH ROW EXECUTE FUNCTION reject_confirmation_mutation();
-- The API role is server-only; all routes enforce actor/organization scope.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT,INSERT ON identity_confirmations TO oi_pr2_api;
  GRANT SELECT,INSERT,UPDATE ON recognition_miss_queue TO oi_pr2_api;
  CREATE POLICY api_confirmation_select ON identity_confirmations FOR SELECT TO oi_pr2_api USING(true);
  CREATE POLICY api_confirmation_insert ON identity_confirmations FOR INSERT TO oi_pr2_api WITH CHECK(true);
  CREATE POLICY api_miss_queue ON recognition_miss_queue TO oi_pr2_api USING(true) WITH CHECK(true);
 END IF;
END $$;
