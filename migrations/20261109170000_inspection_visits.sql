-- DRAFT. NOT APPLIED to any hosted database.
-- One fire-door visit groups the openings an inspector checks at one facility
-- before a single combined report. Older inspections stay ungrouped.

CREATE TABLE IF NOT EXISTS inspection_visits (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  property_id UUID NOT NULL REFERENCES properties(id),
  inspector_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  report_storage_key TEXT,
  report_sha256 TEXT,
  report_generated_at TIMESTAMPTZ,
  report_generated_by UUID REFERENCES users(id),
  report_sent_at TIMESTAMPTZ,
  report_recipients TEXT
);

CREATE INDEX IF NOT EXISTS idx_inspection_visits_facility
  ON inspection_visits (organization_id, property_id, inspector_user_id, created_at DESC);

ALTER TABLE inspection_events ADD COLUMN IF NOT EXISTS visit_id UUID REFERENCES inspection_visits(id);

CREATE INDEX IF NOT EXISTS idx_inspection_events_visit ON inspection_events (visit_id);

ALTER TABLE inspection_visits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE ON inspection_visits TO oi_pr2_api;
  END IF;
END $$;

DO $$ DECLARE roles text; r record; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'inspection_visits'
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM %s', r.t, roles); END IF;
  END LOOP;
END $$;
