-- DRAFT (Oct 29 2026, 10:04 approval). NOT APPLIED to any database. Apply only with its own approval,
-- after 20261030090700_recognition_runs.sql.
-- 1. Per-company monthly recognition budget with an atomic check-and-spend function.
-- 2. 'refused' run status (budget refusal recorded on the run with a reason).
-- 3. Tracked downscale of originals for recognition only (derived copy checksum linked to original).

CREATE TABLE IF NOT EXISTS recognition_budgets (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  period_month DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  limit_cents INTEGER NOT NULL CHECK (limit_cents >= 0),
  per_run_cents INTEGER NOT NULL CHECK (per_run_cents > 0),
  reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  set_by_user_id UUID NOT NULL REFERENCES users(id),
  set_reason TEXT NOT NULL CHECK (length(btrim(set_reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, period_month),
  -- The guard can never be exceeded, whatever writes the row.
  CONSTRAINT recognition_budgets_within_limit CHECK (reserved_cents <= limit_cents)
);

CREATE TABLE IF NOT EXISTS recognition_budget_reservations (
  run_id UUID PRIMARY KEY REFERENCES recognition_runs(id),
  organization_id UUID NOT NULL,
  period_month DATE NOT NULL,
  cents INTEGER NOT NULL CHECK (cents > 0),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, period_month) REFERENCES recognition_budgets(organization_id, period_month)
);

ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents > 0);
ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS downscale_used BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_status_check;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_status_check
  CHECK (status IN ('running','succeeded','abstained','failed','ambiguous','refused'));
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_failure_explicit;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_failure_explicit
  CHECK ((status IN ('failed','ambiguous','refused')) = (failure_code IS NOT NULL));
-- A run that reached the provider holds a reservation; a refused run never does.
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_refused_unbilled;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_refused_unbilled
  CHECK (status <> 'refused' OR budget_cents IS NULL);

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

-- Budget fields are set once by the reserve function; keep them out of later edits.
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
     OR (OLD.budget_cents IS NOT NULL AND NEW.budget_cents IS DISTINCT FROM OLD.budget_cents)
     OR (NEW.budget_cents IS DISTINCT FROM OLD.budget_cents AND current_setting('oi.budget_reserve', true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION 'recognition_run_immutable_fields';
  END IF;
  RETURN NEW;
END $$;

-- Atomic check-and-spend. One conditional UPDATE takes the budget row lock; under concurrency each
-- caller re-checks the limit after the lock, so the total can never pass limit_cents.
-- Returns 'reserved', 'budget_exceeded' or 'budget_not_configured'. Never raises for a refusal.
CREATE OR REPLACE FUNCTION recognition_budget_reserve(p_run_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r recognition_runs%ROWTYPE; v_month DATE := date_trunc('month', now())::date; v_cents INTEGER;
BEGIN
  SELECT * INTO r FROM recognition_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' OR r.budget_cents IS NOT NULL THEN RAISE EXCEPTION 'recognition_budget_invalid_run'; END IF;
  UPDATE recognition_budgets b SET reserved_cents = b.reserved_cents + b.per_run_cents
   WHERE b.organization_id = r.organization_id AND b.period_month = v_month
     AND b.reserved_cents + b.per_run_cents <= b.limit_cents
  RETURNING b.per_run_cents INTO v_cents;
  IF v_cents IS NULL THEN
    RETURN CASE WHEN EXISTS (SELECT 1 FROM recognition_budgets WHERE organization_id = r.organization_id AND period_month = v_month)
      THEN 'budget_exceeded' ELSE 'budget_not_configured' END;
  END IF;
  INSERT INTO recognition_budget_reservations(run_id, organization_id, period_month, cents) VALUES (p_run_id, r.organization_id, v_month, v_cents);
  PERFORM set_config('oi.budget_reserve', 'on', true);
  UPDATE recognition_runs SET budget_cents = v_cents WHERE id = p_run_id;
  PERFORM set_config('oi.budget_reserve', 'off', true);
  RETURN 'reserved';
END $$;

CREATE OR REPLACE FUNCTION recognition_budget_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recognition_budget_reservations_append_only'; END $$;
DROP TRIGGER IF EXISTS recognition_budget_reservations_guard ON recognition_budget_reservations;
CREATE TRIGGER recognition_budget_reservations_guard BEFORE UPDATE OR DELETE ON recognition_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION recognition_budget_reservations_guard();

-- A new run can never arrive pre-billed; budget_cents is only ever set by recognition_budget_reserve.
CREATE OR REPLACE FUNCTION recognition_runs_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.budget_cents IS NOT NULL THEN RAISE EXCEPTION 'recognition_run_insert_invalid'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recognition_runs_insert_guard ON recognition_runs;
CREATE TRIGGER recognition_runs_insert_guard BEFORE INSERT ON recognition_runs
  FOR EACH ROW EXECUTE FUNCTION recognition_runs_insert_guard();

ALTER TABLE recognition_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION recognition_budget_reserve(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    -- The API reads budgets and spends only through the function; no direct UPDATE of budgets.
    GRANT SELECT ON recognition_budgets, recognition_budget_reservations TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION recognition_budget_reserve(UUID) TO oi_pr2_api;
    GRANT UPDATE (downscale_used) ON recognition_runs TO oi_pr2_api;
  END IF;
END $$;
