-- DRAFT. NOT APPLIED to any hosted database.
-- Door-hardware identification runs (Roboflow workflow oi-door-hardware-recognition).
-- One run sends 3-9 stored photographs. The technician confirms or edits each item.
-- Confirmed photographs and their labels are kept for a later training set.
-- Does not alter photos, photo_upload_reservations, or hardware_components.
-- Those existing tables hold the photograph bytes and the confirmed parts.

CREATE TABLE IF NOT EXISTS hardware_recognition_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id),
  daily_run_limit INTEGER NOT NULL CHECK (daily_run_limit BETWEEN 0 AND 100000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hardware_recognition_daily_usage (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  run_day DATE NOT NULL,
  run_count INTEGER NOT NULL CHECK (run_count >= 0),
  PRIMARY KEY (organization_id, run_day)
);

CREATE TABLE IF NOT EXISTS hardware_recognition_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  property_id UUID NOT NULL REFERENCES properties(id),
  opening_id UUID NOT NULL REFERENCES openings(id),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  client_request_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'pending_review', 'confirmed', 'failed', 'refused', 'ambiguous')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),
  photo_count SMALLINT NOT NULL CHECK (photo_count BETWEEN 0 AND 9),
  provider_called BOOLEAN NOT NULL DEFAULT false,
  result JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_by_user_id UUID REFERENCES users(id),
  CONSTRAINT hardware_recognition_runs_failure CHECK (
    (status IN ('failed', 'refused', 'ambiguous')) = (failure_code IS NOT NULL)
  ),
  CONSTRAINT hardware_recognition_runs_running_open CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS hardware_recognition_runs_request_uidx
  ON hardware_recognition_runs (requested_by_user_id, client_request_id);
CREATE INDEX IF NOT EXISTS hardware_recognition_runs_org_day_idx
  ON hardware_recognition_runs (organization_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS hardware_recognition_runs_opening_idx
  ON hardware_recognition_runs (opening_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS hardware_recognition_run_photos (
  run_id UUID NOT NULL REFERENCES hardware_recognition_runs(id),
  photo_id UUID NOT NULL REFERENCES photos(id),
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 9),
  sha256_checksum TEXT NOT NULL CHECK (sha256_checksum ~ '^[0-9a-f]{64}$'),
  sent_byte_size INTEGER CHECK (sent_byte_size IS NULL OR sent_byte_size >= 0),
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, photo_id)
);
CREATE INDEX IF NOT EXISTS hardware_recognition_run_photos_photo_idx
  ON hardware_recognition_run_photos (photo_id);

CREATE TABLE IF NOT EXISTS hardware_recognition_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES hardware_recognition_runs(id),
  ordinal SMALLINT NOT NULL CHECK (ordinal >= 1),
  hardware_type TEXT NOT NULL,
  component_type TEXT NOT NULL CHECK (component_type IN (
    'lockset', 'cylinder', 'closer', 'exit_device', 'hinge',
    'automatic_operator', 'panic_bar', 'access_control_reader',
    'keypad', 'electric_strike', 'power_transfer', 'maglock',
    'request_to_exit_device', 'other'
  )),
  subtype TEXT,
  manufacturer TEXT,
  exact_model TEXT,
  finish TEXT,
  supporting_photos SMALLINT[] NOT NULL DEFAULT '{}',
  visible_evidence TEXT,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  next_photo TEXT,
  model_unknown BOOLEAN NOT NULL DEFAULT false,
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'confirmed', 'dismissed')),
  hardware_component_id UUID REFERENCES hardware_components(id),
  UNIQUE (run_id, ordinal)
);
CREATE INDEX IF NOT EXISTS hardware_recognition_items_run_idx ON hardware_recognition_items (run_id);

-- Confirmed photographs and the label the technician accepted. This is the training set.
CREATE TABLE IF NOT EXISTS hardware_training_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id),
  run_id UUID NOT NULL REFERENCES hardware_recognition_runs(id),
  item_id UUID NOT NULL REFERENCES hardware_recognition_items(id),
  photo_id UUID NOT NULL REFERENCES photos(id),
  photo_ordinal SMALLINT NOT NULL CHECK (photo_ordinal BETWEEN 1 AND 9),
  hardware_component_id UUID REFERENCES hardware_components(id),
  component_type TEXT NOT NULL,
  subtype TEXT,
  manufacturer TEXT,
  model_number TEXT,
  finish TEXT,
  confidence TEXT,
  visible_evidence TEXT,
  confirmed_by_user_id UUID NOT NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  label JSONB NOT NULL,
  UNIQUE (item_id, photo_id)
);
CREATE INDEX IF NOT EXISTS hardware_training_labels_photo_idx ON hardware_training_labels (photo_id);
CREATE INDEX IF NOT EXISTS hardware_training_labels_org_idx ON hardware_training_labels (organization_id, confirmed_at DESC);

ALTER TABLE hardware_recognition_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_recognition_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_recognition_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_recognition_run_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_recognition_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_training_labels ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT ON hardware_recognition_settings, hardware_recognition_daily_usage,
      hardware_recognition_runs, hardware_recognition_run_photos, hardware_recognition_items,
      hardware_training_labels TO oi_pr2_api;
    GRANT INSERT, UPDATE ON hardware_recognition_daily_usage, hardware_recognition_runs,
      hardware_recognition_items TO oi_pr2_api;
    GRANT INSERT ON hardware_recognition_run_photos, hardware_training_labels TO oi_pr2_api;
  END IF;
END $$;

-- Supabase grants new tables to anon and authenticated by default. The API role is oi_pr2_api.
DO $$ DECLARE roles text; r record; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN (
        'hardware_recognition_settings', 'hardware_recognition_daily_usage', 'hardware_recognition_runs',
        'hardware_recognition_run_photos', 'hardware_recognition_items', 'hardware_training_labels'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM %s', r.t, roles); END IF;
  END LOOP;
END $$;
