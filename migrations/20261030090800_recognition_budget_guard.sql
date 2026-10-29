-- DRAFT (Oct 29 2026; revised 11:17 approval). NOT APPLIED to any database. Apply only with its own
-- approval, after 20261030090700_recognition_runs.sql.
-- Decisions: no customer budgets. Usage is tracked and reported to OI staff. OI bills $0.75 per
-- opening per month to BOTH the service provider and the facility. The atomic guard is only an
-- emergency SAFETY CAP per company (photos per month): a missing row never refuses.
-- 1. recognition_usage_settings: price per opening, configurable cost per photo (unknown -> NULL),
--    default monthly photo cap, warning ratio.
-- 2. recognition_safety_caps: optional per-company override of the default cap.
-- 3. recognition_usage_monthly + recognition_usage_reservations: atomic check-and-count.
-- 4. 'refused' run status (only for safety_cap_exceeded), photo_count per run.
-- 5. Tracked downscale of originals for recognition only (derived checksum linked to original).

CREATE TABLE IF NOT EXISTS recognition_usage_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  opening_price_cents_per_month INTEGER NOT NULL DEFAULT 75 CHECK (opening_price_cents_per_month >= 0),
  cost_per_photo_usd NUMERIC(12,6) CHECK (cost_per_photo_usd IS NULL OR cost_per_photo_usd >= 0), -- unknown yet
  -- Expected ~2,000 photos/week (~8,700/month) for a large provider; default cap ~9x that.
  default_monthly_photo_cap INTEGER NOT NULL DEFAULT 80000 CHECK (default_monthly_photo_cap > 0),
  cap_warning_ratio NUMERIC(4,3) NOT NULL DEFAULT 0.8 CHECK (cap_warning_ratio > 0 AND cap_warning_ratio <= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_reason TEXT NOT NULL DEFAULT 'initial defaults (Oct 29 2026 decision)'
);
INSERT INTO recognition_usage_settings(id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS recognition_safety_caps (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id),
  monthly_photo_cap INTEGER NOT NULL CHECK (monthly_photo_cap > 0),
  set_by_user_id UUID NOT NULL REFERENCES users(id),
  set_reason TEXT NOT NULL CHECK (length(btrim(set_reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recognition_usage_monthly (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  period_month DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  photos_counted INTEGER NOT NULL DEFAULT 0 CHECK (photos_counted >= 0),
  runs_counted INTEGER NOT NULL DEFAULT 0 CHECK (runs_counted >= 0),
  PRIMARY KEY (organization_id, period_month)
);

CREATE TABLE IF NOT EXISTS recognition_usage_reservations (
  run_id UUID PRIMARY KEY REFERENCES recognition_runs(id),
  organization_id UUID NOT NULL,
  period_month DATE NOT NULL,
  photo_count INTEGER NOT NULL CHECK (photo_count BETWEEN 1 AND 5),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, period_month) REFERENCES recognition_usage_monthly(organization_id, period_month)
);
CREATE INDEX IF NOT EXISTS recognition_usage_reservations_period_idx ON recognition_usage_reservations (period_month, organization_id);

ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS photo_count INTEGER CHECK (photo_count IS NULL OR photo_count BETWEEN 1 AND 5);
ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS usage_photo_count INTEGER CHECK (usage_photo_count IS NULL OR usage_photo_count BETWEEN 1 AND 5);
ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS downscale_used BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_status_check;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_status_check
  CHECK (status IN ('running','succeeded','abstained','failed','ambiguous','refused'));
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_failure_explicit;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_failure_explicit
  CHECK ((status IN ('failed','ambiguous','refused')) = (failure_code IS NOT NULL));
-- A refused run is never counted as usage, and only the safety cap may refuse.
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_refused_uncounted;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_refused_uncounted
  CHECK (status <> 'refused' OR (usage_photo_count IS NULL AND failure_code = 'safety_cap_exceeded'));
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_usage_matches_photos;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_usage_matches_photos
  CHECK (usage_photo_count IS NULL OR usage_photo_count = photo_count);

ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS downscaled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS original_byte_size BIGINT CHECK (original_byte_size IS NULL OR original_byte_size > 0);
ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS derived_sha256_checksum TEXT CHECK (derived_sha256_checksum IS NULL OR derived_sha256_checksum ~ '^[0-9a-f]{64}$');
ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS derived_byte_size BIGINT CHECK (derived_byte_size IS NULL OR derived_byte_size > 0);
ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS downscale_method_version TEXT;
ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS downscale_target JSONB; -- {max_dimension, quality, format}
ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS derived_width INTEGER;
ALTER TABLE recognition_run_photos ADD COLUMN IF NOT EXISTS derived_height INTEGER;
ALTER TABLE recognition_run_photos DROP CONSTRAINT IF EXISTS recognition_run_photos_downscale_complete;
ALTER TABLE recognition_run_photos ADD CONSTRAINT recognition_run_photos_downscale_complete CHECK (
  downscaled = (derived_sha256_checksum IS NOT NULL AND derived_byte_size IS NOT NULL AND downscale_method_version IS NOT NULL
                AND downscale_target IS NOT NULL AND derived_width > 0 AND derived_height > 0)
  AND (downscaled OR (derived_sha256_checksum IS NULL AND downscale_method_version IS NULL AND downscale_target IS NULL))
  AND (NOT downscaled OR derived_sha256_checksum <> sha256_checksum));

-- usage_photo_count is set once, only by the reserve function; photo_count is fixed at insert.
CREATE OR REPLACE FUNCTION recognition_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recognition_runs_no_delete'; END IF;
  IF OLD.status <> 'running' THEN RAISE EXCEPTION 'recognition_run_finished_is_immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.property_id <> OLD.property_id
     OR NEW.opening_id <> OLD.opening_id OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.client_request_id <> OLD.client_request_id OR NEW.repeat_of_run_id IS DISTINCT FROM OLD.repeat_of_run_id
     OR NEW.mode <> OLD.mode OR NEW.input_source <> OLD.input_source OR NEW.build_commit <> OLD.build_commit
     OR NEW.processing_config <> OLD.processing_config OR NEW.requested_at <> OLD.requested_at
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.photo_count IS DISTINCT FROM OLD.photo_count
     OR (OLD.usage_photo_count IS NOT NULL AND NEW.usage_photo_count IS DISTINCT FROM OLD.usage_photo_count)
     OR (NEW.usage_photo_count IS DISTINCT FROM OLD.usage_photo_count AND current_setting('oi.usage_reserve', true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION 'recognition_run_immutable_fields';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION recognition_runs_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.usage_photo_count IS NOT NULL THEN RAISE EXCEPTION 'recognition_run_insert_invalid'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recognition_runs_insert_guard ON recognition_runs;
CREATE TRIGGER recognition_runs_insert_guard BEFORE INSERT ON recognition_runs
  FOR EACH ROW EXECUTE FUNCTION recognition_runs_insert_guard();

-- Atomic check-and-count against the emergency safety cap. One conditional UPDATE under the
-- monthly row lock; concurrent callers re-check after the lock, so the cap can never be passed.
-- Returns 'reserved' or 'safety_cap_exceeded'. A company with no cap row uses the default cap.
CREATE OR REPLACE FUNCTION recognition_usage_reserve(p_run_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r recognition_runs%ROWTYPE; v_month DATE := date_trunc('month', now())::date; v_n INTEGER; v_cap INTEGER; v_ok INTEGER;
BEGIN
  SELECT * INTO r FROM recognition_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' OR r.usage_photo_count IS NOT NULL THEN RAISE EXCEPTION 'recognition_usage_invalid_run'; END IF;
  SELECT count(*)::int INTO v_n FROM recognition_run_photos WHERE run_id = p_run_id;
  IF v_n < 1 OR v_n IS DISTINCT FROM r.photo_count THEN RAISE EXCEPTION 'recognition_usage_photo_count_mismatch'; END IF;
  SELECT COALESCE((SELECT monthly_photo_cap FROM recognition_safety_caps WHERE organization_id = r.organization_id),
                  (SELECT default_monthly_photo_cap FROM recognition_usage_settings WHERE id), 80000) INTO v_cap;
  INSERT INTO recognition_usage_monthly(organization_id, period_month) VALUES (r.organization_id, v_month) ON CONFLICT DO NOTHING;
  UPDATE recognition_usage_monthly m SET photos_counted = m.photos_counted + v_n, runs_counted = m.runs_counted + 1
   WHERE m.organization_id = r.organization_id AND m.period_month = v_month AND m.photos_counted + v_n <= v_cap
  RETURNING 1 INTO v_ok;
  IF v_ok IS NULL THEN RETURN 'safety_cap_exceeded'; END IF;
  INSERT INTO recognition_usage_reservations(run_id, organization_id, period_month, photo_count) VALUES (p_run_id, r.organization_id, v_month, v_n);
  PERFORM set_config('oi.usage_reserve', 'on', true);
  UPDATE recognition_runs SET usage_photo_count = v_n WHERE id = p_run_id;
  PERFORM set_config('oi.usage_reserve', 'off', true);
  RETURN 'reserved';
END $$;

CREATE OR REPLACE FUNCTION recognition_usage_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recognition_usage_reservations_append_only'; END $$;
DROP TRIGGER IF EXISTS recognition_usage_reservations_guard ON recognition_usage_reservations;
CREATE TRIGGER recognition_usage_reservations_guard BEFORE UPDATE OR DELETE ON recognition_usage_reservations
  FOR EACH ROW EXECUTE FUNCTION recognition_usage_reservations_guard();

ALTER TABLE recognition_usage_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_safety_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_usage_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION recognition_usage_reserve(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    -- Read for the staff report; counting only through the function; no direct writes to caps/usage.
    GRANT SELECT ON recognition_usage_settings, recognition_safety_caps, recognition_usage_monthly, recognition_usage_reservations TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION recognition_usage_reserve(UUID) TO oi_pr2_api;
    GRANT UPDATE (downscale_used) ON recognition_runs TO oi_pr2_api;
  END IF;
END $$;
