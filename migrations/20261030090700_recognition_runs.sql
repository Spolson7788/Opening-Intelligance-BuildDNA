-- DRAFT (t130, Oct 29 2026). NOT APPLIED to any database. Apply only with its own approval.
-- Hosting plan step 1: one record per recognition run, linking the stored original photo(s)
-- (id + sha256), opening, facility, organization, build commit, processing config, status
-- (including explicit failure), conservative result, timestamps and requester.
-- No paid-call budget here (next step). No checksum uniqueness: the same photo may be run again
-- on purpose; upload dedupe stays in photos/sync receipts.
-- Independent of the unapplied 20261030090600 draft: neither reads the other's objects.

CREATE TABLE IF NOT EXISTS recognition_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),   -- requester's active company
  property_id UUID NOT NULL REFERENCES properties(id),          -- facility at request time
  opening_id UUID NOT NULL REFERENCES openings(id),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  client_request_id UUID NOT NULL,                              -- idempotency key from the caller
  repeat_of_run_id UUID REFERENCES recognition_runs(id),        -- intentional re-run of an earlier run
  mode TEXT NOT NULL CHECK (mode IN ('identify','label_blind','marking_regions','hardware_regions')),
  input_source TEXT NOT NULL DEFAULT 'stored_original' CHECK (input_source IN ('stored_original')),
  build_commit TEXT NOT NULL CHECK (length(btrim(build_commit)) BETWEEN 1 AND 64),
  processing_config JSONB NOT NULL CHECK (jsonb_typeof(processing_config) = 'object'
    AND processing_config ? 'engine' AND processing_config ? 'model'
    AND processing_config ? 'prompt_version' AND processing_config ? 'preprocessing_version'),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','abstained','failed','ambiguous')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),
  result JSONB,
  result_level TEXT CHECK (result_level IN ('none','manufacturer','series','model')),
  manufacturer TEXT, series TEXT, model TEXT,
  requires_technician_review BOOLEAN NOT NULL DEFAULT true CHECK (requires_technician_review),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- failed / ambiguous always say why; success never carries a failure code.
  CONSTRAINT recognition_runs_failure_explicit CHECK (
    (status IN ('failed','ambiguous')) = (failure_code IS NOT NULL)),
  CONSTRAINT recognition_runs_terminal_finished CHECK ((status = 'running') = (finished_at IS NULL)),
  -- Conservative identity: a level is stored only together with every level above it.
  CONSTRAINT recognition_runs_level_consistent CHECK (
    (status IN ('succeeded','abstained')) = (result_level IS NOT NULL) AND
    CASE result_level
      WHEN 'model' THEN manufacturer IS NOT NULL AND series IS NOT NULL AND model IS NOT NULL
      WHEN 'series' THEN manufacturer IS NOT NULL AND series IS NOT NULL AND model IS NULL
      WHEN 'manufacturer' THEN manufacturer IS NOT NULL AND series IS NULL AND model IS NULL
      ELSE manufacturer IS NULL AND series IS NULL AND model IS NULL END),
  CONSTRAINT recognition_runs_abstained_none CHECK ((status = 'abstained') = (result_level IS NOT DISTINCT FROM 'none'))
);
-- Same caller + same request id = the same run (a replay never triggers a second paid call).
CREATE UNIQUE INDEX IF NOT EXISTS recognition_runs_client_request_uidx
  ON recognition_runs (requested_by_user_id, client_request_id);
CREATE INDEX IF NOT EXISTS recognition_runs_opening_idx ON recognition_runs (opening_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS recognition_runs_org_idx ON recognition_runs (organization_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS recognition_run_photos (
  run_id UUID NOT NULL REFERENCES recognition_runs(id),
  photo_id UUID NOT NULL REFERENCES photos(id),
  sha256_checksum TEXT NOT NULL CHECK (sha256_checksum ~ '^[0-9a-f]{64}$'), -- copied at run time
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  PRIMARY KEY (run_id, photo_id),
  UNIQUE (run_id, ordinal)
);
-- Deliberately NO unique index on sha256_checksum or photo_id: repeat runs are allowed.
CREATE INDEX IF NOT EXISTS recognition_run_photos_photo_idx ON recognition_run_photos (photo_id);

-- Run history is append-only: no deletes; a finished run is frozen; identity columns never change.
CREATE OR REPLACE FUNCTION recognition_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recognition_runs_no_delete'; END IF;
  IF OLD.status <> 'running' THEN RAISE EXCEPTION 'recognition_run_finished_is_immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.property_id <> OLD.property_id
     OR NEW.opening_id <> OLD.opening_id OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.client_request_id <> OLD.client_request_id OR NEW.repeat_of_run_id IS DISTINCT FROM OLD.repeat_of_run_id
     OR NEW.mode <> OLD.mode OR NEW.input_source <> OLD.input_source OR NEW.build_commit <> OLD.build_commit
     OR NEW.processing_config <> OLD.processing_config OR NEW.requested_at <> OLD.requested_at
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'recognition_run_immutable_fields';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recognition_runs_guard ON recognition_runs;
CREATE TRIGGER recognition_runs_guard BEFORE UPDATE OR DELETE ON recognition_runs
  FOR EACH ROW EXECUTE FUNCTION recognition_runs_guard();

CREATE OR REPLACE FUNCTION recognition_run_photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'recognition_run_photos_append_only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recognition_runs r JOIN photos p ON p.id = NEW.photo_id
                 WHERE r.id = NEW.run_id AND r.status = 'running' AND p.opening_id = r.opening_id
                   AND p.sha256_checksum = NEW.sha256_checksum) THEN
    RAISE EXCEPTION 'recognition_run_photo_mismatch';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recognition_run_photos_guard ON recognition_run_photos;
CREATE TRIGGER recognition_run_photos_guard BEFORE INSERT OR UPDATE OR DELETE ON recognition_run_photos
  FOR EACH ROW EXECUTE FUNCTION recognition_run_photos_guard();

ALTER TABLE recognition_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_run_photos ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT ON recognition_runs, recognition_run_photos TO oi_pr2_api;
    GRANT UPDATE (status, failure_code, result, result_level, manufacturer, series, model, finished_at)
      ON recognition_runs TO oi_pr2_api;
  END IF;
END $$;
