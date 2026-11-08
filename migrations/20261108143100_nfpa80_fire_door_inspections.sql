-- DRAFT. NOT APPLIED to any hosted database.
-- NFPA 80 swinging fire door annual inspection: inspector qualification,
-- one deficiency row per failed checklist item, and a three-year retention hold.

ALTER TABLE inspection_events ADD COLUMN IF NOT EXISTS inspector_qualification TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS inline_bytes BYTEA;

CREATE TABLE IF NOT EXISTS fire_door_deficiencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id),
  inspection_event_id UUID NOT NULL REFERENCES inspection_events(id),
  item_key TEXT NOT NULL,
  note TEXT NOT NULL,
  photo_id UUID REFERENCES photos(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'repaired', 'reinspected')),
  repair_note TEXT,
  repaired_at TIMESTAMPTZ,
  repaired_by_user_id UUID REFERENCES users(id),
  reinspection_event_id UUID REFERENCES inspection_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fire_door_deficiencies_opening ON fire_door_deficiencies(opening_id, created_at DESC);

ALTER TABLE fire_door_deficiencies ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE ON fire_door_deficiencies TO oi_pr2_api;
  END IF;
END $$;

DO $$ DECLARE roles text; r record; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'fire_door_deficiencies'
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM %s', r.t, roles); END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION prevent_early_inspection_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.created_at > now() - interval '3 years' THEN
    RAISE EXCEPTION 'inspection_retention' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inspection_events_retain_three_years ON inspection_events;
CREATE TRIGGER inspection_events_retain_three_years
  BEFORE DELETE ON inspection_events
  FOR EACH ROW EXECUTE FUNCTION prevent_early_inspection_delete();

DROP TRIGGER IF EXISTS fire_door_deficiencies_retain_three_years ON fire_door_deficiencies;
CREATE TRIGGER fire_door_deficiencies_retain_three_years
  BEFORE DELETE ON fire_door_deficiencies
  FOR EACH ROW EXECUTE FUNCTION prevent_early_inspection_delete();

CREATE OR REPLACE FUNCTION prevent_early_deficiency_photo_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM fire_door_deficiencies d
    WHERE d.photo_id = OLD.id AND d.created_at > now() - interval '3 years'
  ) THEN
    RAISE EXCEPTION 'inspection_retention' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS photos_retain_deficiency_evidence ON photos;
CREATE TRIGGER photos_retain_deficiency_evidence
  BEFORE DELETE ON photos
  FOR EACH ROW EXECUTE FUNCTION prevent_early_deficiency_photo_delete();
