-- Production schema bundle for the r59 app bc7c4b975a5e7a694dbe2ad8208f7bc323eb8b71.
-- Source of truth: schema-only dump of oi-production (bekaxmatcvxqpjixwsqn) taken 2026-11-12 07:05 MST.
-- Do not run against a hosted database from this repository commit. scripts/apply-production-schema-bundle.mjs refuses production and staging project refs.
-- One transaction. Does not drop policies named prod_api_*.
-- Password reset, staff MFA, and staff sign-in code objects already exist on that dump. Those three files are idempotent and are still recorded in public.schema_migrations.
-- NOT REVERSIBLE to a hand-edited trigger body: the NFPA BEFORE DELETE triggers are new on the Nov 12 dump. Rollback drops them.
-- The recognition and staff MFA files replace platform_audit_events_action_check and the last of those replacements matches the Nov 12 dump. An audit row whose action is outside that list aborts the whole transaction.

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE filename = '20261111210000_company_dashboard_phase2.sql') THEN
    RAISE EXCEPTION 'production_r59_bundle_already_applied';
  END IF;
END $$;

-- ===== migrations/016_password_reset.sql =====
-- Self-service password reset links. Store only the SHA-256 hash. One use, at most 30 minutes.
-- session_version already exists for admin-issued account recovery; do not add it again.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON public.password_reset_tokens(user_id, created_at DESC);

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.password_reset_tokens FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.password_reset_tokens FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.password_reset_tokens FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE ON public.password_reset_tokens TO oi_pr2_api;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'password_reset_tokens' AND policyname = 'oi_pr2_api_reset_select') THEN
      CREATE POLICY oi_pr2_api_reset_select ON public.password_reset_tokens FOR SELECT TO oi_pr2_api USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'password_reset_tokens' AND policyname = 'oi_pr2_api_reset_insert') THEN
      CREATE POLICY oi_pr2_api_reset_insert ON public.password_reset_tokens FOR INSERT TO oi_pr2_api WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'password_reset_tokens' AND policyname = 'oi_pr2_api_reset_update') THEN
      CREATE POLICY oi_pr2_api_reset_update ON public.password_reset_tokens FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- ===== migrations/20261030090700_recognition_runs.sql =====
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

-- ===== migrations/20261030090800_recognition_budget_guard.sql =====
-- DRAFT (Oct 29 2026; revised 11:17 approval). NOT APPLIED to any database. Apply only with its own
-- approval, after 20261030090700_recognition_runs.sql.
-- Decisions: no customer budgets. Usage is tracked and reported to OI staff. The atomic guard is only
-- an emergency SAFETY CAP per company (photos per month): a missing row never refuses.
-- Billing (11:42 decision): $0.75 per ACTIVE opening per month, whether or not recognition ran. The
-- facility owner company pays for every active opening in its facilities, and every service provider
-- assigned to that facility pays for the same opening while assigned. A provider's own facility
-- (owned by the provider company) is billed once, to the provider; only OI staff may assign others to it. Recognition cost per photo is OI's
-- INTERNAL cost only (never billed). Sections 6-7 keep the history the monthly bill needs.
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

-- 6. Billing history, kept independently of openings/facilities (11:56 decision): no foreign keys
-- to openings or properties and no cascading delete; each period stores the identifiers it needs.
-- BILLABLE OPENING: an opening is billable while its status is 'active' (captured). 'pending_capture'
-- (uncaptured placeholder) and 'decommissioned' are not billable. A billable period opens when the
-- status becomes 'active' and closes when it leaves 'active' or the opening is deleted.
-- An opening bills a FULL month (no proration) to the facility owner when a billable period overlaps
-- the month; to an assigned provider only when a billable period overlaps one of that provider's
-- assignment periods for the facility inside the month (not for openings added after it left).
-- The current facility_provider_assignments row is overwritten on re-grant, so periods are kept here.
CREATE TABLE IF NOT EXISTS opening_billable_periods (
  id BIGSERIAL PRIMARY KEY,
  opening_id UUID NOT NULL,              -- no FK: history survives deleting the opening
  opening_code TEXT NOT NULL,
  property_id UUID NOT NULL,             -- snapshot at period start (no FK)
  property_name TEXT NOT NULL,
  owner_organization_id UUID NOT NULL,   -- facility owner at period start (no FK)
  started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('status_changed','opening_deleted','owner_changed','backfill')),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS opening_billable_periods_one_open ON opening_billable_periods(opening_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS opening_billable_periods_property ON opening_billable_periods(property_id, started_at);
CREATE TABLE IF NOT EXISTS facility_provider_assignment_periods (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL,             -- no FK: history survives deleting the facility
  provider_organization_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('revoked','assignment_deleted','backfill')),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS facility_provider_assignment_periods_one_open
  ON facility_provider_assignment_periods(property_id, provider_organization_id) WHERE ended_at IS NULL;

-- History rows are only written by the tracking triggers: closed periods are immutable and never deleted.
CREATE OR REPLACE FUNCTION billing_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'billing_history_no_delete'; END IF;
  IF OLD.ended_at IS NOT NULL OR NEW.started_at <> OLD.started_at OR NEW.id <> OLD.id
     OR (to_jsonb(NEW) - 'ended_at' - 'end_reason') <> (to_jsonb(OLD) - 'ended_at' - 'end_reason') THEN
    RAISE EXCEPTION 'billing_history_immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS opening_billable_periods_guard ON opening_billable_periods;
CREATE TRIGGER opening_billable_periods_guard BEFORE UPDATE OR DELETE ON opening_billable_periods FOR EACH ROW EXECUTE FUNCTION billing_periods_guard();
DROP TRIGGER IF EXISTS facility_provider_assignment_periods_guard ON facility_provider_assignment_periods;
CREATE TRIGGER facility_provider_assignment_periods_guard BEFORE UPDATE OR DELETE ON facility_provider_assignment_periods FOR EACH ROW EXECUTE FUNCTION billing_periods_guard();

CREATE OR REPLACE FUNCTION opening_billable_periods_track() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.status = 'active' AND (TG_OP = 'DELETE' OR NEW.status <> 'active') THEN
    UPDATE opening_billable_periods SET ended_at = greatest(now(), started_at),
      end_reason = CASE WHEN TG_OP = 'DELETE' THEN 'opening_deleted' ELSE 'status_changed' END
     WHERE opening_id = OLD.id AND ended_at IS NULL;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    INSERT INTO opening_billable_periods(opening_id, opening_code, property_id, property_name, owner_organization_id, started_at)
    SELECT NEW.id, NEW.opening_code, p.id, p.name, pf.organization_id, CASE WHEN TG_OP = 'INSERT' THEN NEW.created_at ELSE now() END
      FROM buildings b JOIN properties p ON p.id = b.property_id JOIN portfolios pf ON pf.id = p.portfolio_id WHERE b.id = NEW.building_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS opening_billable_periods_track ON openings;
CREATE TRIGGER opening_billable_periods_track AFTER INSERT OR UPDATE OF status OR DELETE ON openings
  FOR EACH ROW EXECUTE FUNCTION opening_billable_periods_track();

CREATE OR REPLACE FUNCTION facility_provider_assignment_periods_track() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE facility_provider_assignment_periods SET ended_at = greatest(now(), started_at), end_reason = 'assignment_deleted'
     WHERE property_id = OLD.property_id AND provider_organization_id = OLD.provider_organization_id AND ended_at IS NULL;
  ELSIF NEW.revoked_at IS NULL AND (TG_OP = 'INSERT' OR OLD.revoked_at IS NOT NULL) THEN
    INSERT INTO facility_provider_assignment_periods(property_id, provider_organization_id, started_at)
      VALUES (NEW.property_id, NEW.provider_organization_id, NEW.granted_at) ON CONFLICT DO NOTHING;
  ELSIF NEW.revoked_at IS NOT NULL AND TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL THEN
    UPDATE facility_provider_assignment_periods SET ended_at = greatest(NEW.revoked_at, started_at), end_reason = 'revoked'
     WHERE property_id = NEW.property_id AND provider_organization_id = NEW.provider_organization_id AND ended_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS facility_provider_assignment_periods_track ON facility_provider_assignments;
CREATE TRIGGER facility_provider_assignment_periods_track AFTER INSERT OR UPDATE OR DELETE ON facility_provider_assignments
  FOR EACH ROW EXECUTE FUNCTION facility_provider_assignment_periods_track();

-- 6a. Facility owner changes (12:10 decision): billing switches to the new owner FROM THE MOVE.
-- Moving an opening (building_id), a building (property_id), a facility (portfolio_id) or a portfolio
-- (organization_id) closes each affected open period ('owner_changed') and opens a new one with the
-- new snapshot at now(). The old owner keeps its history (and is billed for the month of the move,
-- since any part of a month bills a full month).
CREATE OR REPLACE FUNCTION opening_billable_periods_rehome(p_openings UUID[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT bp.id, o.id AS opening_id, o.opening_code, p.id AS property_id, p.name AS property_name, pf.organization_id AS owner
      FROM opening_billable_periods bp JOIN openings o ON o.id = bp.opening_id JOIN buildings b ON b.id = o.building_id
      JOIN properties p ON p.id = b.property_id JOIN portfolios pf ON pf.id = p.portfolio_id
      WHERE bp.ended_at IS NULL AND bp.opening_id = ANY(p_openings)
        AND (bp.property_id, bp.owner_organization_id) IS DISTINCT FROM (p.id, pf.organization_id) LOOP
    UPDATE opening_billable_periods SET ended_at = greatest(now(), started_at), end_reason = 'owner_changed' WHERE id = r.id;
    INSERT INTO opening_billable_periods(opening_id, opening_code, property_id, property_name, owner_organization_id, started_at)
      VALUES (r.opening_id, r.opening_code, r.property_id, r.property_name, r.owner, now());
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION opening_billable_periods_on_move() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'openings' THEN
    PERFORM opening_billable_periods_rehome(ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'buildings' THEN
    PERFORM opening_billable_periods_rehome(ARRAY(SELECT id FROM openings WHERE building_id = NEW.id));
  ELSIF TG_TABLE_NAME = 'properties' THEN
    PERFORM opening_billable_periods_rehome(ARRAY(SELECT o.id FROM openings o JOIN buildings b ON b.id = o.building_id WHERE b.property_id = NEW.id));
  ELSIF TG_TABLE_NAME = 'portfolios' THEN
    PERFORM opening_billable_periods_rehome(ARRAY(SELECT o.id FROM openings o JOIN buildings b ON b.id = o.building_id
      JOIN properties p ON p.id = b.property_id WHERE p.portfolio_id = NEW.id));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS opening_billable_periods_move ON openings;
CREATE TRIGGER opening_billable_periods_move AFTER UPDATE OF building_id ON openings
  FOR EACH ROW WHEN (NEW.building_id IS DISTINCT FROM OLD.building_id) EXECUTE FUNCTION opening_billable_periods_on_move();
DROP TRIGGER IF EXISTS opening_billable_periods_move ON buildings;
CREATE TRIGGER opening_billable_periods_move AFTER UPDATE OF property_id ON buildings
  FOR EACH ROW WHEN (NEW.property_id IS DISTINCT FROM OLD.property_id) EXECUTE FUNCTION opening_billable_periods_on_move();
DROP TRIGGER IF EXISTS opening_billable_periods_move ON properties;
CREATE TRIGGER opening_billable_periods_move AFTER UPDATE OF portfolio_id ON properties
  FOR EACH ROW WHEN (NEW.portfolio_id IS DISTINCT FROM OLD.portfolio_id) EXECUTE FUNCTION opening_billable_periods_on_move();
DROP TRIGGER IF EXISTS opening_billable_periods_move ON portfolios;
CREATE TRIGGER opening_billable_periods_move AFTER UPDATE OF organization_id ON portfolios
  FOR EACH ROW WHEN (NEW.organization_id IS DISTINCT FROM OLD.organization_id) EXECUTE FUNCTION opening_billable_periods_on_move();

-- Go-live backfill (12:10 decision): billing starts when this migration is APPLIED. Go-live (the first
-- invoiced month) should be the 1st of a month (12:23 decision); an earlier apply only adds history.
-- In a month where ownership moves, only the owner at month end is billed (report).
-- Go-live backfill: billing starts when this migration is APPLIED. Openings that are
-- 'active' at apply time start a billable period at now(); decommissioned and pending_capture openings
-- get none. Active provider assignments start at now(); revoked ones are not billable history.
-- BACKFILL-BEGIN
INSERT INTO opening_billable_periods(opening_id, opening_code, property_id, property_name, owner_organization_id, started_at)
SELECT o.id, o.opening_code, p.id, p.name, pf.organization_id, now()
FROM openings o JOIN buildings b ON b.id = o.building_id JOIN properties p ON p.id = b.property_id JOIN portfolios pf ON pf.id = p.portfolio_id
WHERE o.status = 'active' AND NOT EXISTS (SELECT 1 FROM opening_billable_periods x WHERE x.opening_id = o.id AND x.ended_at IS NULL);
INSERT INTO facility_provider_assignment_periods(property_id, provider_organization_id, started_at)
SELECT a.property_id, a.provider_organization_id, now()
FROM facility_provider_assignments a
WHERE a.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM facility_provider_assignment_periods x
  WHERE x.property_id = a.property_id AND x.provider_organization_id = a.provider_organization_id AND x.ended_at IS NULL);
-- BACKFILL-END

-- 6b. Provider-owned facilities: only OI staff may ASSIGN a provider to them (revoking stays open).
-- Billing (12:10 decision): only the owning provider is billed for their openings; any additional
-- provider staff assigns there is NOT billed (see the report).
-- Enforced in the database for every writer: the transaction must name an acting user
-- (set_config('oi.actor_user_id', ..., true)) who is OI staff.
CREATE OR REPLACE FUNCTION facility_provider_assignments_provider_owned_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor TEXT := nullif(current_setting('oi.actor_user_id', true), '');
BEGIN
  IF NEW.revoked_at IS NULL AND (TG_OP = 'INSERT' OR OLD.revoked_at IS NOT NULL OR NEW.provider_organization_id <> OLD.provider_organization_id
       OR NEW.property_id <> OLD.property_id)
     AND EXISTS (SELECT 1 FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id JOIN organizations o ON o.id = pf.organization_id
                 WHERE p.id = NEW.property_id AND o.org_type = 'service_partner')
     AND (actor IS NULL OR NOT is_platform_staff(actor::uuid)) THEN
    RAISE EXCEPTION 'provider_facility_assignment_requires_oi_staff';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS facility_provider_assignments_provider_owned_guard ON facility_provider_assignments;
CREATE TRIGGER facility_provider_assignments_provider_owned_guard BEFORE INSERT OR UPDATE ON facility_provider_assignments
  FOR EACH ROW EXECUTE FUNCTION facility_provider_assignments_provider_owned_guard();
-- RLS: the Data API roles get no policy on the assignment table (deny), so only the server writes it.
ALTER TABLE facility_provider_assignments ENABLE ROW LEVEL SECURITY;

-- 7. Provider-owned facilities need no new table: a facility (property) in a portfolio owned by the
-- service-provider company. Access stays owner-or-assignment, so other providers never see it.
ALTER TABLE opening_billable_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_provider_assignment_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION opening_billable_periods_track() FROM PUBLIC;
REVOKE ALL ON FUNCTION facility_provider_assignment_periods_track() FROM PUBLIC;
REVOKE ALL ON FUNCTION facility_provider_assignments_provider_owned_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION opening_billable_periods_rehome(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION opening_billable_periods_on_move() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT ON opening_billable_periods, facility_provider_assignment_periods TO oi_pr2_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON opening_billable_periods, facility_provider_assignment_periods FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON opening_billable_periods, facility_provider_assignment_periods FROM authenticated; END IF;
END $$;

-- 8. OI-staff edit of price, recognition cost and safety caps (12:23 decision). Tables stay
-- read-only for the API role; changes go only through these SECURITY DEFINER functions, which
-- re-check that the actor is OI staff, validate, require a reason, and write platform_audit_events
-- (old and new values) in the same transaction.
ALTER TABLE recognition_safety_caps ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE recognition_usage_settings ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES users(id);
ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
    'org_created','first_admin_invited','facility_created',
    'staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked',
    'org_parent_changed','membership_added','membership_removed',
    'usage_settings_changed','safety_cap_set','safety_cap_removed'));

CREATE OR REPLACE FUNCTION recognition_usage_settings_update(p_actor UUID, p_actor_org UUID, p_reason TEXT, p_price_cents INTEGER,
  p_cost_per_photo_usd NUMERIC, p_cost_set BOOLEAN, p_default_cap INTEGER, p_warning_ratio NUMERIC)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o recognition_usage_settings%ROWTYPE; n recognition_usage_settings%ROWTYPE; actor_org UUID;
BEGIN
  IF p_actor IS NULL OR NOT is_platform_staff(p_actor) THEN RAISE EXCEPTION 'usage_settings_requires_oi_staff'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'usage_settings_reason_required'; END IF;
  IF p_price_cents IS NOT NULL AND (p_price_cents < 0 OR p_price_cents > 100000) THEN RAISE EXCEPTION 'usage_settings_invalid_price'; END IF;
  IF p_cost_set AND p_cost_per_photo_usd IS NOT NULL AND (p_cost_per_photo_usd < 0 OR p_cost_per_photo_usd > 100
     OR p_cost_per_photo_usd <> round(p_cost_per_photo_usd, 6)) THEN RAISE EXCEPTION 'usage_settings_invalid_cost'; END IF;
  IF p_default_cap IS NOT NULL AND (p_default_cap < 1 OR p_default_cap > 10000000) THEN RAISE EXCEPTION 'usage_settings_invalid_cap'; END IF;
  IF p_warning_ratio IS NOT NULL AND (p_warning_ratio < 0.05 OR p_warning_ratio > 1 OR p_warning_ratio <> round(p_warning_ratio, 3)) THEN
    RAISE EXCEPTION 'usage_settings_invalid_warning_ratio'; END IF;
  SELECT * INTO o FROM recognition_usage_settings WHERE id FOR UPDATE;
  UPDATE recognition_usage_settings SET
    opening_price_cents_per_month = COALESCE(p_price_cents, opening_price_cents_per_month),
    cost_per_photo_usd = CASE WHEN p_cost_set THEN p_cost_per_photo_usd ELSE cost_per_photo_usd END,
    default_monthly_photo_cap = COALESCE(p_default_cap, default_monthly_photo_cap),
    cap_warning_ratio = COALESCE(p_warning_ratio, cap_warning_ratio),
    updated_at = now(), updated_reason = btrim(p_reason), updated_by_user_id = p_actor
  WHERE id RETURNING * INTO n;
  actor_org := COALESCE(p_actor_org, (SELECT organization_id FROM users WHERE id = p_actor));
  INSERT INTO platform_audit_events(actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
  VALUES (p_actor, actor_org, 'usage_settings_changed', NULL, NULL, btrim(p_reason),
    jsonb_build_object('opening_price_cents_per_month', o.opening_price_cents_per_month, 'cost_per_photo_usd', o.cost_per_photo_usd,
      'default_monthly_photo_cap', o.default_monthly_photo_cap, 'cap_warning_ratio', o.cap_warning_ratio),
    jsonb_build_object('opening_price_cents_per_month', n.opening_price_cents_per_month, 'cost_per_photo_usd', n.cost_per_photo_usd,
      'default_monthly_photo_cap', n.default_monthly_photo_cap, 'cap_warning_ratio', n.cap_warning_ratio));
  RETURN jsonb_build_object('opening_price_cents_per_month', n.opening_price_cents_per_month, 'cost_per_photo_usd', n.cost_per_photo_usd,
      'default_monthly_photo_cap', n.default_monthly_photo_cap, 'cap_warning_ratio', n.cap_warning_ratio);
END $$;

-- p_cap NULL removes the company's override (it falls back to the default cap).
CREATE OR REPLACE FUNCTION recognition_safety_cap_set(p_actor UUID, p_actor_org UUID, p_org UUID, p_cap INTEGER, p_reason TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE old_cap INTEGER; actor_org UUID; t TEXT;
BEGIN
  IF p_actor IS NULL OR NOT is_platform_staff(p_actor) THEN RAISE EXCEPTION 'usage_settings_requires_oi_staff'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'usage_settings_reason_required'; END IF;
  SELECT org_type INTO t FROM organizations WHERE id = p_org;
  IF t IS NULL OR t NOT IN ('customer','service_partner') THEN RAISE EXCEPTION 'safety_cap_invalid_company'; END IF;
  IF p_cap IS NOT NULL AND (p_cap < 1 OR p_cap > 10000000) THEN RAISE EXCEPTION 'usage_settings_invalid_cap'; END IF;
  SELECT monthly_photo_cap INTO old_cap FROM recognition_safety_caps WHERE organization_id = p_org FOR UPDATE;
  IF p_cap IS NULL THEN
    DELETE FROM recognition_safety_caps WHERE organization_id = p_org;
  ELSE
    INSERT INTO recognition_safety_caps(organization_id, monthly_photo_cap, set_by_user_id, set_reason)
    VALUES (p_org, p_cap, p_actor, btrim(p_reason))
    ON CONFLICT (organization_id) DO UPDATE SET monthly_photo_cap = EXCLUDED.monthly_photo_cap,
      set_by_user_id = EXCLUDED.set_by_user_id, set_reason = EXCLUDED.set_reason, updated_at = now();
  END IF;
  actor_org := COALESCE(p_actor_org, (SELECT organization_id FROM users WHERE id = p_actor));
  INSERT INTO platform_audit_events(actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
  VALUES (p_actor, actor_org, CASE WHEN p_cap IS NULL THEN 'safety_cap_removed' ELSE 'safety_cap_set' END, p_org, p_org, btrim(p_reason),
    jsonb_build_object('monthly_photo_cap', old_cap), jsonb_build_object('monthly_photo_cap', p_cap));
  RETURN jsonb_build_object('organization_id', p_org, 'monthly_photo_cap', p_cap, 'previous_monthly_photo_cap', old_cap);
END $$;
REVOKE ALL ON FUNCTION recognition_usage_settings_update(UUID, UUID, TEXT, INTEGER, NUMERIC, BOOLEAN, INTEGER, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION recognition_safety_cap_set(UUID, UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT EXECUTE ON FUNCTION recognition_usage_settings_update(UUID, UUID, TEXT, INTEGER, NUMERIC, BOOLEAN, INTEGER, NUMERIC) TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION recognition_safety_cap_set(UUID, UUID, UUID, INTEGER, TEXT) TO oi_pr2_api;
  END IF;
END $$;

-- ===== migrations/20261030090900_recognition_revoke_public_access.sql =====
-- Applied to staging boaoedvyvifppuklbwad 2026-10-29 13:19 MST (approved by Stephan, card t140s733).
-- The applied text revoked from anon, authenticated directly; this file only adds a role-existence guard.
-- Hardening after 090700/090800, same pattern as 20261030090300_c3_revoke_public_access: Supabase default
-- privileges give anon/authenticated rights on new tables and EXECUTE on new functions. Remove them.
-- oi_pr2_api keeps its explicit grants (SELECT; INSERT on runs; EXECUTE on reserve and the two staff
-- edit functions). Trigger functions do not need EXECUTE at fire time.
DO $$ DECLARE r record; roles text; BEGIN
  -- Only roles that exist (both exist on Supabase; local test databases may lack them).
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon','authenticated');
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('recognition_runs','recognition_run_photos','recognition_usage_settings','recognition_safety_caps',
                      'recognition_usage_monthly','recognition_usage_reservations','opening_billable_periods','facility_provider_assignment_periods')
  LOOP IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM %s', r.t, roles); END IF; END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND (p.proname LIKE 'recognition\_%' OR p.proname LIKE 'opening\_billable\_periods%' OR p.proname LIKE 'facility\_provider\_assignment%' OR p.proname = 'billing_periods_guard')
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.f);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.f, roles); END IF; END LOOP;
END $$;

-- ===== migrations/20261030091000_reference_library.sql =====
-- Reference library in the app schema (Stephan approved the milestone 2026-10-29 14:57 MST, card pt150u).
-- DRAFT: not applied anywhere. Ports the opening-intelligence-staging (ioqfdcehnhnqpnqawwvo) library
-- (reference_documents / _document_models / _pages / _conflicts, same column names and types) and adds:
--   * revision + source origin + received date per document,
--   * licence/permission per use: storage, AI processing, customer display,
--   * structured product dimensions with units, endpoints, orientation, configuration, tolerance,
--     source page and verification status,
--   * look-alike (hard-negative) groups,
--   * versioned, immutable reference releases; recognition reads only the single active release.
-- Everything imports as draft. Only OI staff approve or publish, through SECURITY DEFINER functions
-- that re-check staff, require a reason and write platform_audit_events in the same transaction.
-- RLS on every table; anon/authenticated revoked (lesson from 090900); oi_pr2_api read-only.
-- Storage keys must be private object keys (never URLs); the bucket itself stays private.

CREATE TABLE IF NOT EXISTS reference_documents (
  sha256 TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  manufacturer TEXT NOT NULL CHECK (length(btrim(manufacturer)) > 0),
  brand TEXT NOT NULL,
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count >= 0),
  storage_key TEXT NOT NULL CHECK (storage_key !~* '^(https?:|//)' AND storage_key !~* '(^|/)public/'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded','duplicate','rejected')),
  superseded_by TEXT REFERENCES reference_documents(sha256),
  duplicate_of TEXT REFERENCES reference_documents(sha256),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  -- additions
  revision TEXT NOT NULL DEFAULT 'unknown' CHECK (length(btrim(revision)) > 0),
  source_origin TEXT,                       -- manufacturer URL or PC path + package name
  received_on DATE,
  licence_storage TEXT NOT NULL DEFAULT 'unknown' CHECK (licence_storage IN ('unknown','permitted','restricted','denied')),
  licence_ai_processing TEXT NOT NULL DEFAULT 'unknown' CHECK (licence_ai_processing IN ('unknown','permitted','restricted','denied')),
  licence_customer_display TEXT NOT NULL DEFAULT 'unknown' CHECK (licence_customer_display IN ('unknown','permitted','restricted','denied')),
  licence_note TEXT,
  interim_only BOOLEAN NOT NULL DEFAULT false,
  imported_from TEXT,                        -- e.g. 'ioqfdcehnhnqpnqawwvo', 'pc:registry_v17'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reference_documents_approval_complete CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status IN ('superseded')),
  CONSTRAINT reference_documents_approved_needs_ai_licence CHECK (status <> 'approved' OR (licence_ai_processing = 'permitted' AND licence_storage = 'permitted' AND NOT interim_only))
);

CREATE TABLE IF NOT EXISTS reference_document_models (
  id BIGSERIAL PRIMARY KEY,
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  model TEXT NOT NULL,
  series TEXT,
  variant TEXT,
  evidence_page INTEGER NOT NULL CHECK (evidence_page >= 1),
  evidence_quote TEXT NOT NULL,
  UNIQUE (doc_sha256, model, evidence_page)
);

CREATE TABLE IF NOT EXISTS reference_pages (
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  page_no INTEGER NOT NULL CHECK (page_no >= 1),
  page_id TEXT,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  page_class TEXT NOT NULL,
  transcription_status TEXT NOT NULL,
  citable BOOLEAN NOT NULL,
  fraction_unverified BOOLEAN NOT NULL DEFAULT false,
  image_key TEXT CHECK (image_key IS NULL OR image_key !~* '^(https?:|//)'),
  image_sha256 TEXT CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
  search_vector TSVECTOR,
  PRIMARY KEY (doc_sha256, page_no)
);

CREATE TABLE IF NOT EXISTS reference_conflicts (
  id BIGSERIAL PRIMARY KEY,
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  field TEXT NOT NULL,
  "values" JSONB NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false
);

-- Product identities (from the 2,442-row registry and documents). Draft until approved.
CREATE TABLE IF NOT EXISTS reference_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer TEXT NOT NULL CHECK (length(btrim(manufacturer)) > 0),
  brand TEXT,
  component_class TEXT,
  series TEXT,
  model TEXT NOT NULL CHECK (length(btrim(model)) > 0),
  registry_row_ref TEXT,
  spec_sheet_url TEXT,
  cut_sheet_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','superseded')),
  interim_only BOOLEAN NOT NULL DEFAULT false,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  imported_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reference_products_approved_not_interim CHECK (status <> 'approved' OR NOT interim_only),
  CONSTRAINT reference_products_approval_complete CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status = 'superseded')
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_products_identity ON reference_products (lower(manufacturer), lower(model), COALESCE(lower(series), ''));

-- Which document pages support which product.
CREATE TABLE IF NOT EXISTS reference_product_sources (
  product_id UUID NOT NULL REFERENCES reference_products(id),
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  page_no INTEGER NOT NULL CHECK (page_no >= 1),
  PRIMARY KEY (product_id, doc_sha256, page_no)
);

-- Structured dimensions. A verified dimension always has a value, units, normalized mm and a cited page.
CREATE TABLE IF NOT EXISTS reference_dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES reference_products(id),
  name TEXT NOT NULL,                       -- e.g. 'latch_case_height'
  value NUMERIC,
  units TEXT CHECK (units IS NULL OR units IN ('in','mm','cm','deg','lb','kg')),
  normalized_mm NUMERIC,                    -- lengths normalized to mm (null for non-length units)
  endpoint_a TEXT, endpoint_b TEXT,         -- what the measurement runs between
  orientation TEXT CHECK (orientation IS NULL OR orientation IN ('height','width','depth','projection','diameter','backset','offset','angle','other')),
  configuration TEXT,                       -- e.g. handing, function, option the value applies to
  tolerance TEXT,
  source_doc_sha256 TEXT REFERENCES reference_documents(sha256),
  source_page INTEGER CHECK (source_page IS NULL OR source_page >= 1),
  dimension_source TEXT,                    -- free text from manifests (e.g. source PDF name)
  claim_tier TEXT,                          -- e.g. 'CONFIRMATORY ONLY / NOT IDENTITY'
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','manufacturer_stated','verified','rejected')),
  does_not_establish TEXT,
  imported_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reference_dimensions_verified_complete CHECK (verification_status <> 'verified' OR
    (value IS NOT NULL AND units IS NOT NULL AND source_doc_sha256 IS NOT NULL AND source_page IS NOT NULL
     AND (units NOT IN ('in','mm','cm') OR normalized_mm IS NOT NULL)))
);

-- Look-alike / hard-negative groups (seeded from the Von Duprin hard-negatives set).
CREATE TABLE IF NOT EXISTS reference_lookalike_groups (
  id TEXT PRIMARY KEY,                      -- e.g. 'CS-XM-001'
  name TEXT NOT NULL,
  basis TEXT,
  source_document TEXT,
  source_locator TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  may_support_promotion BOOLEAN NOT NULL DEFAULT false,
  imported_from TEXT
);
CREATE TABLE IF NOT EXISTS reference_lookalike_members (
  group_id TEXT NOT NULL REFERENCES reference_lookalike_groups(id),
  member_key TEXT NOT NULL,                 -- e.g. 'VD-22'
  manufacturer TEXT NOT NULL,
  series_or_model TEXT NOT NULL,
  product_id UUID REFERENCES reference_products(id),
  PRIMARY KEY (group_id, member_key)
);
CREATE TABLE IF NOT EXISTS reference_lookalike_pairs (
  id TEXT PRIMARY KEY,                      -- e.g. 'CF-0001'
  group_id TEXT REFERENCES reference_lookalike_groups(id),
  member_a TEXT NOT NULL, member_b TEXT NOT NULL,
  confusion_basis TEXT, basis_statement TEXT, does_not_establish TEXT,
  document_number TEXT, source_locator TEXT
);

-- Manifest-level assets (image packages; checksums from the package manifests). Never approved by import.
CREATE TABLE IF NOT EXISTS reference_assets (
  id BIGSERIAL PRIMARY KEY,
  package TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  asset_type TEXT,
  byte_size BIGINT,
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  interim_only BOOLEAN NOT NULL DEFAULT false,
  recognition_use_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (package, relative_path)
);

-- Versioned, immutable releases. Items are frozen content hashes; recognition pins to one release.
CREATE TABLE IF NOT EXISTS reference_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','retired')),
  published_by UUID NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_releases_one_active ON reference_releases ((true)) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS reference_release_items (
  release_id UUID NOT NULL REFERENCES reference_releases(id),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('document','page','product','dimension','lookalike_group')),
  item_key TEXT NOT NULL,
  content JSONB NOT NULL,                   -- frozen copy of what recognition may use
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (release_id, item_kind, item_key)
);

CREATE OR REPLACE FUNCTION reference_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'reference_release_items' THEN RAISE EXCEPTION 'reference_release_immutable'; END IF;
  -- Releases: only active -> retired (sets retired_at) is allowed; nothing else changes, never deleted.
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reference_release_immutable'; END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired' AND NEW.retired_at IS NOT NULL
     AND (NEW.id, NEW.version, NEW.published_by, NEW.published_at, NEW.reason, NEW.item_count, NEW.content_sha256)
       IS NOT DISTINCT FROM (OLD.id, OLD.version, OLD.published_by, OLD.published_at, OLD.reason, OLD.item_count, OLD.content_sha256)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'reference_release_immutable';
END $$;
DROP TRIGGER IF EXISTS reference_release_items_immutable ON reference_release_items;
CREATE TRIGGER reference_release_items_immutable BEFORE UPDATE OR DELETE ON reference_release_items
  FOR EACH ROW EXECUTE FUNCTION reference_release_immutable();
DROP TRIGGER IF EXISTS reference_releases_immutable ON reference_releases;
CREATE TRIGGER reference_releases_immutable BEFORE UPDATE OR DELETE ON reference_releases
  FOR EACH ROW EXECUTE FUNCTION reference_release_immutable();

-- Approved documents keep their content: only the status may move to superseded/duplicate.
CREATE OR REPLACE FUNCTION reference_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN RAISE EXCEPTION 'reference_document_approved_immutable'; END IF; RETURN OLD; END IF;
  IF OLD.status = 'approved' AND (NEW.sha256, NEW.manufacturer, NEW.brand, NEW.title, NEW.doc_type, NEW.page_count, NEW.storage_key, NEW.revision)
     IS DISTINCT FROM (OLD.sha256, OLD.manufacturer, OLD.brand, OLD.title, OLD.doc_type, OLD.page_count, OLD.storage_key, OLD.revision)
  THEN RAISE EXCEPTION 'reference_document_approved_immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_documents_guard ON reference_documents;
CREATE TRIGGER reference_documents_guard BEFORE UPDATE OR DELETE ON reference_documents
  FOR EACH ROW EXECUTE FUNCTION reference_documents_guard();

-- Recognition runs record which release they used and what they cited.
ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS reference_release_id UUID REFERENCES reference_releases(id);
ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS reference_citations JSONB NOT NULL DEFAULT '{"cited":[],"rejected":[]}'::jsonb
  CHECK (jsonb_typeof(reference_citations) = 'object');

-- Audit actions.
ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
    'org_created','first_admin_invited','facility_created',
    'staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked',
    'org_parent_changed','membership_added','membership_removed',
    'usage_settings_changed','safety_cap_set','safety_cap_removed',
    'reference_document_approved','reference_product_approved','reference_dimension_verified','reference_lookalike_group_approved','reference_release_published'));

-- Staff-only approval. p_kind: 'document' (key = sha256), 'product' (key = uuid), 'dimension' (key = uuid), 'lookalike_group' (key = id).
CREATE OR REPLACE FUNCTION reference_approve(p_actor UUID, p_actor_org UUID, p_kind TEXT, p_key TEXT, p_reason TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor_org UUID; before jsonb; act TEXT;
BEGIN
  IF p_actor IS NULL OR NOT is_platform_staff(p_actor) THEN RAISE EXCEPTION 'reference_requires_oi_staff'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'reference_reason_required'; END IF;
  IF p_kind = 'document' THEN
    SELECT to_jsonb(d) - 'metadata' INTO before FROM reference_documents d WHERE sha256 = p_key FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF before->>'status' <> 'draft' THEN RAISE EXCEPTION 'reference_not_draft'; END IF;
    UPDATE reference_documents SET status = 'approved', approved_by = p_actor, approved_at = now() WHERE sha256 = p_key;
    act := 'reference_document_approved';
  ELSIF p_kind = 'product' THEN
    SELECT to_jsonb(p) INTO before FROM reference_products p WHERE id = p_key::uuid FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF before->>'status' <> 'draft' THEN RAISE EXCEPTION 'reference_not_draft'; END IF;
    -- A product is approved only with at least one approved, AI-permitted source document page.
    IF NOT EXISTS (SELECT 1 FROM reference_product_sources s JOIN reference_documents d ON d.sha256 = s.doc_sha256
                   WHERE s.product_id = p_key::uuid AND d.status = 'approved') THEN RAISE EXCEPTION 'reference_product_needs_approved_source'; END IF;
    UPDATE reference_products SET status = 'approved', approved_by = p_actor, approved_at = now() WHERE id = p_key::uuid;
    act := 'reference_product_approved';
  ELSIF p_kind = 'dimension' THEN
    SELECT to_jsonb(x) INTO before FROM reference_dimensions x WHERE id = p_key::uuid FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF NOT EXISTS (SELECT 1 FROM reference_documents d WHERE d.sha256 = before->>'source_doc_sha256' AND d.status = 'approved')
      THEN RAISE EXCEPTION 'reference_dimension_needs_approved_source'; END IF;
    UPDATE reference_dimensions SET verification_status = 'verified' WHERE id = p_key::uuid;
    act := 'reference_dimension_verified';
  ELSIF p_kind = 'lookalike_group' THEN
    SELECT to_jsonb(g) INTO before FROM reference_lookalike_groups g WHERE id = p_key FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF before->>'status' <> 'draft' THEN RAISE EXCEPTION 'reference_not_draft'; END IF;
    UPDATE reference_lookalike_groups SET status = 'approved' WHERE id = p_key;
    act := 'reference_lookalike_group_approved';
  ELSE RAISE EXCEPTION 'reference_invalid_kind'; END IF;
  actor_org := COALESCE(p_actor_org, (SELECT organization_id FROM users WHERE id = p_actor));
  INSERT INTO platform_audit_events(actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
  VALUES (p_actor, actor_org, act, NULL, NULL, btrim(p_reason), before, jsonb_build_object('kind', p_kind, 'key', p_key));
  RETURN jsonb_build_object('kind', p_kind, 'key', p_key, 'action', act);
END $$;

-- Staff-only publish: freezes every approved document/page/product/verified dimension/approved group
-- into a new version, activates it and retires the previous one. Nothing in a release can change later.
CREATE OR REPLACE FUNCTION reference_release_publish(p_actor UUID, p_actor_org UUID, p_reason TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rid UUID := gen_random_uuid(); v INTEGER; n INTEGER; h TEXT; prev UUID; actor_org UUID;
BEGIN
  IF p_actor IS NULL OR NOT is_platform_staff(p_actor) THEN RAISE EXCEPTION 'reference_requires_oi_staff'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'reference_reason_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reference_release_publish'));
  SELECT COALESCE(max(version), 0) + 1 INTO v FROM reference_releases;
  CREATE TEMP TABLE _rel_items ON COMMIT DROP AS
    SELECT 'document'::text k, d.sha256 key, jsonb_build_object('sha256', d.sha256, 'manufacturer', d.manufacturer, 'brand', d.brand, 'title', d.title,
      'doc_type', d.doc_type, 'revision', d.revision, 'page_count', d.page_count, 'licence_customer_display', d.licence_customer_display) c
      FROM reference_documents d WHERE d.status = 'approved'
    UNION ALL
    SELECT 'page', p.doc_sha256 || ':' || p.page_no, jsonb_build_object('doc_sha256', p.doc_sha256, 'page_no', p.page_no, 'text_sha256', p.text_sha256,
      'page_class', p.page_class, 'text', left(p.text, 4000))
      FROM reference_pages p JOIN reference_documents d ON d.sha256 = p.doc_sha256 WHERE d.status = 'approved' AND p.citable AND NOT p.fraction_unverified
    UNION ALL
    SELECT 'product', pr.id::text, jsonb_build_object('id', pr.id, 'manufacturer', pr.manufacturer, 'brand', pr.brand, 'component_class', pr.component_class,
      'series', pr.series, 'model', pr.model,
      'sources', (SELECT COALESCE(jsonb_agg(jsonb_build_object('doc_sha256', s.doc_sha256, 'page_no', s.page_no) ORDER BY s.doc_sha256, s.page_no), '[]'::jsonb)
                  FROM reference_product_sources s JOIN reference_documents d ON d.sha256 = s.doc_sha256 WHERE s.product_id = pr.id AND d.status = 'approved'))
      FROM reference_products pr WHERE pr.status = 'approved'
    UNION ALL
    SELECT 'dimension', x.id::text, jsonb_build_object('id', x.id, 'product_id', x.product_id, 'name', x.name, 'value', x.value, 'units', x.units,
      'normalized_mm', x.normalized_mm, 'endpoint_a', x.endpoint_a, 'endpoint_b', x.endpoint_b, 'orientation', x.orientation,
      'configuration', x.configuration, 'tolerance', x.tolerance, 'source_doc_sha256', x.source_doc_sha256, 'source_page', x.source_page)
      FROM reference_dimensions x JOIN reference_products pr ON pr.id = x.product_id
      WHERE x.verification_status = 'verified' AND pr.status = 'approved'
    UNION ALL
    SELECT 'lookalike_group', g.id, jsonb_build_object('id', g.id, 'name', g.name, 'basis', g.basis,
      'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', m.member_key, 'manufacturer', m.manufacturer, 'series_or_model', m.series_or_model) ORDER BY m.member_key), '[]'::jsonb)
                  FROM reference_lookalike_members m WHERE m.group_id = g.id))
      FROM reference_lookalike_groups g WHERE g.status = 'approved';
  SELECT count(*), encode(sha256(convert_to(COALESCE(string_agg(k || '|' || key || '|' || c::text, E'\n' ORDER BY k, key), ''), 'UTF8')), 'hex')
    INTO n, h FROM _rel_items;
  SELECT id INTO prev FROM reference_releases WHERE status = 'active' FOR UPDATE;
  IF prev IS NOT NULL THEN UPDATE reference_releases SET status = 'retired', retired_at = now() WHERE id = prev; END IF;
  INSERT INTO reference_releases(id, version, status, published_by, reason, item_count, content_sha256)
    VALUES (rid, v, 'active', p_actor, btrim(p_reason), n, h);
  INSERT INTO reference_release_items(release_id, item_kind, item_key, content, content_sha256)
    SELECT rid, k, key, c, encode(sha256(convert_to(c::text, 'UTF8')), 'hex') FROM _rel_items;
  actor_org := COALESCE(p_actor_org, (SELECT organization_id FROM users WHERE id = p_actor));
  INSERT INTO platform_audit_events(actor_user_id, actor_org_id, action, target_id, reason, before_state, after_state)
  VALUES (p_actor, actor_org, 'reference_release_published', rid, btrim(p_reason),
    jsonb_build_object('previous_release_id', prev), jsonb_build_object('release_id', rid, 'version', v, 'item_count', n, 'content_sha256', h));
  RETURN jsonb_build_object('release_id', rid, 'version', v, 'item_count', n, 'content_sha256', h, 'previous_release_id', prev);
END $$;

-- RLS on, no policies for anon/authenticated; API role reads only.
DO $$ DECLARE t text; roles text; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon','authenticated');
  FOREACH t IN ARRAY ARRAY['reference_documents','reference_document_models','reference_pages','reference_conflicts','reference_products',
    'reference_product_sources','reference_dimensions','reference_lookalike_groups','reference_lookalike_members','reference_lookalike_pairs',
    'reference_assets','reference_releases','reference_release_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %I FROM %s', t, roles); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
      EXECUTE format('GRANT SELECT ON %I TO oi_pr2_api', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_api_read', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO oi_pr2_api USING (true)', t || '_api_read', t);
    END IF;
  END LOOP;
END $$;
DO $$ DECLARE r record; roles text; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon','authenticated');
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'reference\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.f);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.f, roles); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT EXECUTE ON FUNCTION reference_approve(UUID, UUID, TEXT, TEXT, TEXT) TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION reference_release_publish(UUID, UUID, TEXT) TO oi_pr2_api;
  END IF;
END $$;

-- ===== migrations/20261031090000_recognition_run_records.sql =====
-- DRAFT (Oct 31 2026, approved milestone "recognition run records" + 10:28 follow-ups). NOT APPLIED
-- to any database. Apply only with its own approval, after 20261030091000_reference_library.sql.
-- One row per photo per recognition attempt: company, requester, facility, opening, photo, the
-- matched manufacturer / series / model with their confidence scores, OI's cost per photo (snapshot
-- of recognition_usage_settings.cost_per_photo_usd), status, reason and timestamp.
-- Status: 'succeeded' (provider answered; may have matched nothing), 'failed' (any failure during a
-- run, including an unknown provider outcome or an unexpected error), 'blocked_by_cap' (the atomic
-- emergency safety cap refused) or 'rejected' (refused BEFORE a run existed: invalid request,
-- opening not found, recognition disabled, ...). Rejected attempts have no run and no photo, and
-- only carry the facility/opening when the requester could reach the opening.
-- Every row is keyed by (attempt_id, photo_slot): for runs attempt_id = run id; writes are
-- idempotent so retries and outbox reprocessing never duplicate a record.
-- Thresholds (shown to customers; no shadow mode): manufacturer >= 0.5, series >= 0.5, model >= 0.6
-- plus a transcribed marking / evidence. A level is only stored with every level above it.
-- Append-only: rows are never updated or deleted (retained history).
-- RLS (server role oi_pr2_api; the acting user is set per transaction with
-- set_config('oi.actor_user_id', <user id>, true)):
--   * OI staff (is_platform_staff) see every row;
--   * active members of the facility owner company see every row at that facility;
--   * active members of the requesting company see its own rows only while that company still has
--     an active (non-revoked) provider assignment: revoked providers lose access to past records;
--   * rows without a facility (rejected before the opening was resolved) are visible to active
--     members of the requesting company only (plus OI staff);
--   * no actor set -> no rows. The server may insert; nobody may update or delete.
-- 'replayed' (10:39 follow-up): a repeat of an earlier request that returned the existing run. One
-- row (no photo, no provider call, no cost) pointing at that run; never counted as a run, a photo
-- attempt or cost.
-- Record writes that still fail after retries go to recognition_run_record_outbox (server-only).
-- recognition_run_record_outbox_reprocess() replays it (FOR UPDATE SKIP LOCKED, safe to run
-- concurrently); used by the staff endpoint and by the optional pg_cron job shipped NOT applied in
-- docs/scheduled/recognition_record_outbox_reprocess_cron.sql.
-- recognition_access_denials (10:39 follow-up): 401/403 responses on the recognition endpoints,
-- written by middleware outside the handlers. Without a verified identity (user/company NULL)
-- only OI staff see them; otherwise staff and active members of that company.
CREATE TABLE IF NOT EXISTS recognition_run_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL,
  photo_slot SMALLINT NOT NULL DEFAULT 0 CHECK (photo_slot BETWEEN 0 AND 4),
  run_id UUID REFERENCES recognition_runs(id),                  -- NULL only for 'rejected'
  organization_id UUID NOT NULL REFERENCES organizations(id),   -- requesting company
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  property_id UUID REFERENCES properties(id),                   -- facility
  opening_id UUID REFERENCES openings(id),
  photo_id UUID REFERENCES photos(id),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','blocked_by_cap','rejected','replayed')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),  -- the reason
  manufacturer TEXT, manufacturer_confidence NUMERIC(5,4),
  series TEXT, series_confidence NUMERIC(5,4),
  model TEXT, model_confidence NUMERIC(5,4),
  model_marking_evidence BOOLEAN NOT NULL DEFAULT false,
  provider_called BOOLEAN NOT NULL,
  cost_per_photo_usd NUMERIC(12,6) CHECK (cost_per_photo_usd IS NULL OR cost_per_photo_usd >= 0), -- NULL = cost not configured
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, photo_slot),
  CONSTRAINT recognition_run_records_failure_explicit CHECK ((status <> 'succeeded') = (failure_code IS NOT NULL)),
  CONSTRAINT recognition_run_records_rejected_no_run CHECK ((status = 'rejected') = (run_id IS NULL)),
  CONSTRAINT recognition_run_records_run_complete CHECK (run_id IS NULL OR status = 'replayed' OR (attempt_id = run_id AND property_id IS NOT NULL
    AND opening_id IS NOT NULL AND photo_id IS NOT NULL)),
  CONSTRAINT recognition_run_records_rejected_shape CHECK (status <> 'rejected' OR (photo_id IS NULL AND photo_slot = 0 AND NOT provider_called)),
  CONSTRAINT recognition_run_records_replayed_shape CHECK (status <> 'replayed' OR (failure_code = 'replay_of_existing_run' AND photo_id IS NULL
    AND photo_slot = 0 AND NOT provider_called AND cost_per_photo_usd IS NULL AND attempt_id <> run_id AND opening_id IS NOT NULL)),
  CONSTRAINT recognition_run_records_opening_facility CHECK ((opening_id IS NULL) = (property_id IS NULL)),
  CONSTRAINT recognition_run_records_blocked CHECK (status <> 'blocked_by_cap' OR (failure_code = 'safety_cap_exceeded' AND NOT provider_called)),
  CONSTRAINT recognition_run_records_match_only_on_success CHECK (status = 'succeeded' OR (manufacturer IS NULL AND series IS NULL AND model IS NULL)),
  CONSTRAINT recognition_run_records_success_called CHECK (status <> 'succeeded' OR provider_called),
  CONSTRAINT recognition_run_records_value_conf CHECK (
    (manufacturer IS NULL) = (manufacturer_confidence IS NULL) AND (series IS NULL) = (series_confidence IS NULL)
    AND (model IS NULL) = (model_confidence IS NULL)),
  CONSTRAINT recognition_run_records_hierarchy CHECK ((series IS NULL OR manufacturer IS NOT NULL) AND (model IS NULL OR series IS NOT NULL)),
  CONSTRAINT recognition_run_records_thresholds CHECK (
    (manufacturer_confidence IS NULL OR manufacturer_confidence BETWEEN 0.5 AND 1)
    AND (series_confidence IS NULL OR series_confidence BETWEEN 0.5 AND 1)
    AND (model_confidence IS NULL OR (model_confidence BETWEEN 0.6 AND 1 AND model_marking_evidence)))
);
CREATE INDEX IF NOT EXISTS recognition_run_records_org_month_idx ON recognition_run_records (organization_id, recorded_at);
CREATE INDEX IF NOT EXISTS recognition_run_records_property_idx ON recognition_run_records (property_id, recorded_at);
CREATE INDEX IF NOT EXISTS recognition_run_records_opening_idx ON recognition_run_records (opening_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS recognition_run_records_run_idx ON recognition_run_records (run_id);

CREATE OR REPLACE FUNCTION recognition_run_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recognition_run_records_append_only'; END $$;
DROP TRIGGER IF EXISTS recognition_run_records_guard ON recognition_run_records;
CREATE TRIGGER recognition_run_records_guard BEFORE UPDATE OR DELETE ON recognition_run_records
  FOR EACH ROW EXECUTE FUNCTION recognition_run_records_guard();

-- Visibility for the acting user (see header). SECURITY DEFINER so the check can read memberships,
-- assignments and staff rows that the caller itself cannot read.
CREATE OR REPLACE FUNCTION recognition_run_record_visible(p_org UUID, p_property UUID) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE raw TEXT := nullif(current_setting('oi.actor_user_id', true), ''); actor UUID; owner UUID; member BOOLEAN;
BEGIN
  IF raw IS NULL OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  actor := raw::uuid;
  IF is_platform_staff(actor) THEN RETURN true; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = actor AND is_active) THEN RETURN false; END IF;
  member := EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = actor AND m.organization_id = p_org AND m.is_active);
  IF p_property IS NULL THEN RETURN member; END IF;
  SELECT pf.organization_id INTO owner FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id WHERE p.id = p_property;
  IF owner IS NOT NULL AND EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = actor AND m.organization_id = owner AND m.is_active) THEN
    RETURN true; END IF;
  RETURN member AND EXISTS (SELECT 1 FROM facility_provider_assignments f WHERE f.property_id = p_property
                  AND f.provider_organization_id = p_org AND f.revoked_at IS NULL);
END $$;

-- Durable fallback for record writes that failed after retries. Server-only (never exposed to the
-- Data API). Rows are kept after reprocessing (processed_at set); never deleted; the payload is frozen.
CREATE TABLE IF NOT EXISTS recognition_run_record_outbox (
  id BIGSERIAL PRIMARY KEY,
  attempt_id UUID NOT NULL,
  record_rows JSONB NOT NULL CHECK (jsonb_typeof(record_rows) = 'array' AND jsonb_array_length(record_rows) BETWEEN 1 AND 5),
  cost_per_photo_usd NUMERIC(12,6),                -- cost snapshot taken when the attempt happened
  first_error TEXT NOT NULL CHECK (length(first_error) BETWEEN 1 AND 300),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS recognition_run_record_outbox_pending_idx ON recognition_run_record_outbox (created_at) WHERE processed_at IS NULL;
CREATE OR REPLACE FUNCTION recognition_run_record_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recognition_run_record_outbox_no_delete'; END IF;
  IF OLD.processed_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.attempt_id <> OLD.attempt_id OR NEW.record_rows <> OLD.record_rows
     OR NEW.cost_per_photo_usd IS DISTINCT FROM OLD.cost_per_photo_usd OR NEW.first_error <> OLD.first_error
     OR NEW.created_at <> OLD.created_at OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'recognition_run_record_outbox_immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recognition_run_record_outbox_guard ON recognition_run_record_outbox;
CREATE TRIGGER recognition_run_record_outbox_guard BEFORE UPDATE OR DELETE ON recognition_run_record_outbox
  FOR EACH ROW EXECUTE FUNCTION recognition_run_record_outbox_guard();

-- Idempotent record write used by the API and by outbox reprocessing. SECURITY DEFINER because
-- INSERT ... ON CONFLICT on an RLS table also requires the conflicting row to be visible to the
-- caller (the server writes with no acting user, so it sees nothing). Only the server role may call
-- it. p_use_cost: true = use p_cost (outbox snapshot), false = snapshot the current setting.
-- Rejected and replayed rows never carry a cost.
CREATE OR REPLACE FUNCTION recognition_run_records_write(p_rows JSONB, p_use_cost BOOLEAN DEFAULT false, p_cost NUMERIC DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n INTEGER; it RECORD;
BEGIN
  SELECT CASE WHEN p_use_cost THEN p_cost ELSE (SELECT cost_per_photo_usd FROM recognition_usage_settings WHERE id) END AS cost_per_photo_usd INTO it;
  INSERT INTO recognition_run_records(attempt_id,photo_slot,run_id,organization_id,requested_by_user_id,property_id,opening_id,photo_id,status,failure_code,manufacturer,manufacturer_confidence,series,series_confidence,model,model_confidence,model_marking_evidence,provider_called,cost_per_photo_usd,recorded_at)
  SELECT x.attempt_id,x.photo_slot,x.run_id,x.organization_id,x.requested_by_user_id,x.property_id,x.opening_id,x.photo_id,x.status,x.failure_code,x.manufacturer,x.manufacturer_confidence,x.series,x.series_confidence,x.model,x.model_confidence,x.model_marking_evidence,x.provider_called,
    CASE WHEN x.status IN ('rejected','replayed') THEN NULL ELSE it.cost_per_photo_usd END, x.recorded_at
  FROM jsonb_to_recordset(p_rows) AS x(attempt_id uuid, photo_slot smallint, run_id uuid, organization_id uuid, requested_by_user_id uuid, property_id uuid,
    opening_id uuid, photo_id uuid, status text, failure_code text, manufacturer text, manufacturer_confidence numeric, series text, series_confidence numeric,
    model text, model_confidence numeric, model_marking_evidence boolean, provider_called boolean, recorded_at timestamptz)
  ON CONFLICT (attempt_id, photo_slot) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Outbox reprocessing (staff endpoint and optional scheduler). Oldest first; FOR UPDATE SKIP LOCKED
-- so concurrent runs never take the same entry; each entry in its own subtransaction: written
-- idempotently with its cost snapshot, then marked processed (kept). A failure bumps attempts.
CREATE OR REPLACE FUNCTION recognition_run_record_outbox_reprocess(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (processed INTEGER, failed INTEGER, pending INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it RECORD; n_ok INTEGER := 0; n_fail INTEGER := 0; msg TEXT; st TEXT;
BEGIN
  FOR it IN SELECT o.id, o.record_rows, o.cost_per_photo_usd FROM recognition_run_record_outbox o
    WHERE o.processed_at IS NULL ORDER BY o.created_at, o.id
    LIMIT greatest(1, least(500, coalesce(p_limit, 100))) FOR UPDATE OF o SKIP LOCKED LOOP
    BEGIN
      PERFORM recognition_run_records_write(it.record_rows, true, it.cost_per_photo_usd);
      UPDATE recognition_run_record_outbox SET attempts = attempts + 1, last_attempt_at = now(), last_error = NULL, processed_at = now() WHERE id = it.id;
      n_ok := n_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, st = RETURNED_SQLSTATE;
      UPDATE recognition_run_record_outbox SET attempts = attempts + 1, last_attempt_at = now(), last_error = left(st || ': ' || msg, 300) WHERE id = it.id;
      n_fail := n_fail + 1;
    END;
  END LOOP;
  processed := n_ok; failed := n_fail;
  SELECT count(*)::int INTO pending FROM recognition_run_record_outbox WHERE processed_at IS NULL;
  RETURN NEXT;
END $$;

-- 401/403 on the recognition endpoints (written by middleware, outside the handlers). Append-only.
CREATE TABLE IF NOT EXISTS recognition_access_denials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  http_status SMALLINT NOT NULL CHECK (http_status IN (401, 403)),
  reason TEXT NOT NULL CHECK (reason ~ '^[a-z0-9_]{1,64}$'),
  endpoint TEXT NOT NULL CHECK (endpoint IN ('recognition_runs', 'recognition')),
  method TEXT NOT NULL CHECK (method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS')),
  user_id UUID REFERENCES users(id),                 -- NULL = no verified identity (OI staff only)
  organization_id UUID REFERENCES organizations(id),
  auth_reference UUID,                              -- X-OI-Auth-Reference returned to the caller
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recognition_access_denials_identity CHECK ((user_id IS NULL) = (organization_id IS NULL))
);
CREATE INDEX IF NOT EXISTS recognition_access_denials_org_idx ON recognition_access_denials (organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS recognition_access_denials_time_idx ON recognition_access_denials (occurred_at);
CREATE OR REPLACE FUNCTION recognition_access_denials_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recognition_access_denials_append_only'; END $$;
DROP TRIGGER IF EXISTS recognition_access_denials_guard ON recognition_access_denials;
CREATE TRIGGER recognition_access_denials_guard BEFORE UPDATE OR DELETE ON recognition_access_denials
  FOR EACH ROW EXECUTE FUNCTION recognition_access_denials_guard();

-- Supabase default privileges grant EXECUTE on new functions to anon/authenticated: remove them.
REVOKE ALL ON FUNCTION recognition_run_record_outbox_reprocess(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION recognition_run_records_write(JSONB, BOOLEAN, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION recognition_access_denials_guard() FROM PUBLIC;
-- Default privileges also grant the outbox id sequence to anon/authenticated (seen on staging).
REVOKE ALL ON SEQUENCE recognition_run_record_outbox_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION recognition_run_record_visible(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION recognition_run_records_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION recognition_run_record_outbox_guard() FROM PUBLIC;

ALTER TABLE recognition_run_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_run_record_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_access_denials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recognition_access_denials_server_insert ON recognition_access_denials;
DROP POLICY IF EXISTS recognition_access_denials_scoped_select ON recognition_access_denials;
DROP POLICY IF EXISTS recognition_run_records_server_insert ON recognition_run_records;
DROP POLICY IF EXISTS recognition_run_records_scoped_select ON recognition_run_records;
DROP POLICY IF EXISTS recognition_run_record_outbox_server ON recognition_run_record_outbox;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    CREATE POLICY recognition_run_records_server_insert ON recognition_run_records FOR INSERT TO oi_pr2_api WITH CHECK (true);
    CREATE POLICY recognition_run_records_scoped_select ON recognition_run_records FOR SELECT TO oi_pr2_api
      USING (recognition_run_record_visible(organization_id, property_id));
    GRANT SELECT, INSERT ON recognition_run_records TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION recognition_run_record_visible(UUID, UUID) TO oi_pr2_api;
    CREATE POLICY recognition_run_record_outbox_server ON recognition_run_record_outbox FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT ON recognition_run_record_outbox TO oi_pr2_api;
    GRANT UPDATE (attempts, last_error, last_attempt_at, processed_at) ON recognition_run_record_outbox TO oi_pr2_api;
    GRANT USAGE ON SEQUENCE recognition_run_record_outbox_id_seq TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION recognition_run_record_outbox_reprocess(INTEGER), recognition_run_records_write(JSONB, BOOLEAN, NUMERIC) TO oi_pr2_api;
    CREATE POLICY recognition_access_denials_server_insert ON recognition_access_denials FOR INSERT TO oi_pr2_api WITH CHECK (true);
    -- NULL company: recognition_run_record_visible() is true for OI staff only.
    CREATE POLICY recognition_access_denials_scoped_select ON recognition_access_denials FOR SELECT TO oi_pr2_api
      USING (recognition_run_record_visible(organization_id, NULL));
    GRANT SELECT, INSERT ON recognition_access_denials TO oi_pr2_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON recognition_run_records, recognition_run_record_outbox, recognition_access_denials FROM anon;
    REVOKE ALL ON SEQUENCE recognition_run_record_outbox_id_seq FROM anon;
    REVOKE ALL ON FUNCTION recognition_run_record_outbox_reprocess(INTEGER), recognition_run_records_write(JSONB, BOOLEAN, NUMERIC), recognition_access_denials_guard() FROM anon;
    REVOKE ALL ON FUNCTION recognition_run_record_visible(UUID, UUID), recognition_run_records_guard(), recognition_run_record_outbox_guard() FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON recognition_run_records, recognition_run_record_outbox, recognition_access_denials FROM authenticated;
    REVOKE ALL ON SEQUENCE recognition_run_record_outbox_id_seq FROM authenticated;
    REVOKE ALL ON FUNCTION recognition_run_record_outbox_reprocess(INTEGER), recognition_run_records_write(JSONB, BOOLEAN, NUMERIC), recognition_access_denials_guard() FROM authenticated;
    REVOKE ALL ON FUNCTION recognition_run_record_visible(UUID, UUID), recognition_run_records_guard(), recognition_run_record_outbox_guard() FROM authenticated; END IF;
END $$;

-- Monthly usage by company (OI staff report). security_invoker: the table's RLS applies to the
-- reader, so staff see every company and anyone else sees only what they could see row by row.
-- Company names are joined by the report (not here) so the view needs no extra grants.
-- Months are UTC calendar months. Photo counts cover run attempts; rejected_attempts counts
-- attempts refused before a run; replayed_attempts counts replays (no run, photo or cost). Cost counts only photos actually sent to the provider.
CREATE OR REPLACE VIEW recognition_run_records_monthly WITH (security_invoker = true) AS
SELECT date_trunc('month', r.recorded_at AT TIME ZONE 'UTC')::date AS period_month,
  r.organization_id,
  count(DISTINCT r.run_id) FILTER (WHERE r.status <> 'replayed')::int AS runs,
  count(*) FILTER (WHERE r.status NOT IN ('rejected','replayed'))::int AS photo_attempts,
  count(*) FILTER (WHERE r.status = 'succeeded')::int AS succeeded_photos,
  count(*) FILTER (WHERE r.status = 'failed')::int AS failed_photos,
  count(*) FILTER (WHERE r.status = 'blocked_by_cap')::int AS blocked_by_cap_photos,
  count(*) FILTER (WHERE r.status = 'rejected')::int AS rejected_attempts,
  count(*) FILTER (WHERE r.status = 'replayed')::int AS replayed_attempts,
  count(*) FILTER (WHERE r.provider_called)::int AS provider_photos,
  count(*) FILTER (WHERE r.manufacturer IS NOT NULL)::int AS manufacturer_matches,
  count(*) FILTER (WHERE r.series IS NOT NULL)::int AS series_matches,
  count(*) FILTER (WHERE r.model IS NOT NULL)::int AS model_matches,
  COALESCE(sum(r.cost_per_photo_usd) FILTER (WHERE r.provider_called), 0)::numeric(14,6) AS oi_cost_usd,
  count(*) FILTER (WHERE r.provider_called AND r.cost_per_photo_usd IS NULL)::int AS provider_photos_without_cost
FROM recognition_run_records r
GROUP BY 1, r.organization_id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN GRANT SELECT ON recognition_run_records_monthly TO oi_pr2_api; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON recognition_run_records_monthly FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON recognition_run_records_monthly FROM authenticated; END IF;
END $$;

-- ===== migrations/20261107130500_staff_mfa.sql =====
-- SEC-2 staff authenticator (TOTP) for OI platform staff.
-- DRAFT: file only. Do not apply this from the app, and do not run npm run migrate
-- against oi-production. Customers are not given an MFA requirement.
-- Does not change platform_staff_regrant (migration 20261030090600).

CREATE TABLE IF NOT EXISTS staff_mfa_factors (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_tag BYTEA NOT NULL,
  confirmed_at TIMESTAMPTZ,
  last_accepted_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS staff_mfa_recovery_codes_user ON staff_mfa_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS staff_mfa_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded BOOLEAN NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('totp', 'recovery', 'lockout_cleared'))
);
CREATE INDEX IF NOT EXISTS staff_mfa_attempts_user_time ON staff_mfa_attempts (user_id, attempted_at DESC);

ALTER TABLE staff_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_mfa_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE staff_mfa_factors FROM PUBLIC;
REVOKE ALL ON TABLE staff_mfa_recovery_codes FROM PUBLIC;
REVOKE ALL ON TABLE staff_mfa_attempts FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE staff_mfa_factors FROM anon;
    REVOKE ALL ON TABLE staff_mfa_recovery_codes FROM anon;
    REVOKE ALL ON TABLE staff_mfa_attempts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE staff_mfa_factors FROM authenticated;
    REVOKE ALL ON TABLE staff_mfa_recovery_codes FROM authenticated;
    REVOKE ALL ON TABLE staff_mfa_attempts FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON staff_mfa_factors TO oi_pr2_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON staff_mfa_recovery_codes TO oi_pr2_api;
    GRANT SELECT, INSERT ON staff_mfa_attempts TO oi_pr2_api;
    GRANT USAGE, SELECT ON SEQUENCE staff_mfa_attempts_id_seq TO oi_pr2_api;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_factors' AND policyname = 'staff_mfa_factors_api') THEN
      CREATE POLICY staff_mfa_factors_api ON staff_mfa_factors FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_recovery_codes' AND policyname = 'staff_mfa_recovery_api') THEN
      CREATE POLICY staff_mfa_recovery_api ON staff_mfa_recovery_codes FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_attempts' AND policyname = 'staff_mfa_attempts_api_select') THEN
      CREATE POLICY staff_mfa_attempts_api_select ON staff_mfa_attempts FOR SELECT TO oi_pr2_api USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_attempts' AND policyname = 'staff_mfa_attempts_api_insert') THEN
      CREATE POLICY staff_mfa_attempts_api_insert ON staff_mfa_attempts FOR INSERT TO oi_pr2_api WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- Keep every action already allowed, and add the peer-reset audit action.
ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
    'org_created','first_admin_invited','facility_created',
    'staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked',
    'org_parent_changed','membership_added','membership_removed',
    'usage_settings_changed','safety_cap_set','safety_cap_removed',
    'reference_document_approved','reference_product_approved','reference_dimension_verified','reference_lookalike_group_approved','reference_release_published',
    'staff_mfa_reset','staff_mfa_lockout_cleared'));

-- ===== migrations/20261107143000_staff_sign_in_codes.sql =====
-- SEC-2 staff emailed sign-in codes. Additive.
-- Do not edit 20261107130500_staff_mfa.sql; that file is already applied on staging.
-- DRAFT until Stephan approves applying it. Do not run npm run migrate against oi-production.

CREATE TABLE IF NOT EXISTS staff_sign_in_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS staff_sign_in_codes_user_created ON staff_sign_in_codes (user_id, created_at DESC);

ALTER TABLE staff_sign_in_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_sign_in_codes FROM PUBLIC;

DO $$
DECLARE kind_check text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE staff_sign_in_codes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE staff_sign_in_codes FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE ON staff_sign_in_codes TO oi_pr2_api;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_sign_in_codes' AND policyname = 'staff_sign_in_codes_api') THEN
      CREATE POLICY staff_sign_in_codes_api ON staff_sign_in_codes FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
  END IF;
  SELECT conname INTO kind_check FROM pg_constraint
   WHERE conrelid = 'staff_mfa_attempts'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%lockout_cleared%';
  IF kind_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE staff_mfa_attempts DROP CONSTRAINT %I', kind_check);
    ALTER TABLE staff_mfa_attempts ADD CONSTRAINT staff_mfa_attempts_kind_check
      CHECK (kind IN ('totp', 'recovery', 'lockout_cleared', 'email'));
  END IF;
END $$;

-- ===== migrations/20261107203000_door_hardware_recognition.sql =====
-- DRAFT. NOT APPLIED to any hosted database.
-- Door-hardware identification runs (Roboflow workflow oi-door-hardware-recognition).
-- One run sends 3-9 stored photographs. The technician confirms or edits each item.
-- Confirmed photographs and their labels are kept for a later training set.
-- Does not alter photos, photo_upload_reservations, or hardware_components.
-- Those existing tables hold the photograph bytes and the confirmed parts.

-- No company-wide cap unless a row sets one. NULL means the company is unlimited.
CREATE TABLE IF NOT EXISTS hardware_recognition_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id),
  daily_run_limit INTEGER CHECK (daily_run_limit IS NULL OR daily_run_limit BETWEEN 0 AND 100000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Optional company cap. Unused while hardware_recognition_settings.daily_run_limit is null.
CREATE TABLE IF NOT EXISTS hardware_recognition_daily_usage (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  run_day DATE NOT NULL,
  run_count INTEGER NOT NULL CHECK (run_count >= 0),
  PRIMARY KEY (organization_id, run_day)
);

-- The default spend cap: one counter per technician per company per UTC day.
CREATE TABLE IF NOT EXISTS hardware_recognition_tech_daily_usage (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  run_day DATE NOT NULL,
  run_count INTEGER NOT NULL CHECK (run_count >= 0),
  PRIMARY KEY (organization_id, user_id, run_day)
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
ALTER TABLE hardware_recognition_tech_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_recognition_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_recognition_run_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_recognition_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_training_labels ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT ON hardware_recognition_settings, hardware_recognition_daily_usage,
      hardware_recognition_tech_daily_usage, hardware_recognition_runs, hardware_recognition_run_photos,
      hardware_recognition_items, hardware_training_labels TO oi_pr2_api;
    GRANT INSERT, UPDATE ON hardware_recognition_daily_usage, hardware_recognition_tech_daily_usage,
      hardware_recognition_runs, hardware_recognition_items TO oi_pr2_api;
    GRANT INSERT ON hardware_recognition_run_photos, hardware_training_labels TO oi_pr2_api;
  END IF;
END $$;

-- Supabase grants new tables to anon and authenticated by default. The API role is oi_pr2_api.
DO $$ DECLARE roles text; r record; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN (
        'hardware_recognition_settings', 'hardware_recognition_daily_usage', 'hardware_recognition_tech_daily_usage',
        'hardware_recognition_runs',
        'hardware_recognition_run_photos', 'hardware_recognition_items', 'hardware_training_labels'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM %s', r.t, roles); END IF;
  END LOOP;
END $$;

-- ===== migrations/20261108143000_purchasing_department_email.sql =====
-- DRAFT. NOT APPLIED to any hosted database.
-- Purchasing department address for a provider company, with an optional branch override.
-- Each send is kept: who, when, where, which opening and component, and which files.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS purchasing_email TEXT;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_purchasing_email_format;
ALTER TABLE organizations ADD CONSTRAINT organizations_purchasing_email_format
  CHECK (purchasing_email IS NULL OR purchasing_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

ALTER TABLE company_branches ADD COLUMN IF NOT EXISTS purchasing_email TEXT;
ALTER TABLE company_branches DROP CONSTRAINT IF EXISTS company_branches_purchasing_email_format;
ALTER TABLE company_branches ADD CONSTRAINT company_branches_purchasing_email_format
  CHECK (purchasing_email IS NULL OR purchasing_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

CREATE TABLE IF NOT EXISTS purchasing_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id),
  hardware_component_id UUID NOT NULL REFERENCES hardware_components(id),
  sent_by_user_id UUID NOT NULL REFERENCES users(id),
  sent_to TEXT NOT NULL,
  note TEXT,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('attachments', 'links')),
  document_ids UUID[] NOT NULL DEFAULT '{}',
  reference_sha256s TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchasing_sends_opening ON purchasing_sends(opening_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchasing_send_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id UUID NOT NULL REFERENCES purchasing_sends(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content BYTEA,
  link_url TEXT,
  source_document_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purchasing_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchasing_send_files ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT ON purchasing_sends, purchasing_send_files TO oi_pr2_api;
  END IF;
END $$;

DO $$ DECLARE roles text; r record; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('purchasing_sends', 'purchasing_send_files')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM %s', r.t, roles); END IF;
  END LOOP;
END $$;

-- ===== migrations/20261108143100_nfpa80_fire_door_inspections.sql =====
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

-- ===== migrations/20261108150000_inspector_license_and_facility_contact.sql =====
-- DRAFT. NOT APPLIED to any hosted database.
-- Free-text inspector license number, and an optional facility contact email
-- used as a default recipient for the inspection report.

ALTER TABLE inspection_events ADD COLUMN IF NOT EXISTS inspector_license_number TEXT;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_contact_email_format;
ALTER TABLE properties ADD CONSTRAINT properties_contact_email_format
  CHECK (contact_email IS NULL OR contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- ===== migrations/20261108160000_inspection_report_records.sql =====
-- A saved fire door inspection report is a document on the opening.
-- The PDF bytes stay in the database. storage_url is a private marker, not a
-- public or token link. One row per inspection, so saving again does not duplicate.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS inspection_event_id UUID UNIQUE REFERENCES inspection_events(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_type TEXT;

-- ===== migrations/20261108171000_fire_door_api_policies.sql =====
-- DRAFT. NOT APPLIED to any hosted database.
-- fire_door_deficiencies had row security on and a grant, but no policy.
-- The API role oi_pr2_api could insert the inspection and the failure photo,
-- then Postgres rejected the deficiency row (42501). The transaction rolled
-- back and the field app reported internal_error.
-- The checklist update and the facility-record insert need the same kind of policy.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    RETURN;
  END IF;

  GRANT SELECT, INSERT, UPDATE ON public.fire_door_deficiencies TO oi_pr2_api;
  GRANT SELECT, UPDATE ON public.inspection_events TO oi_pr2_api;
  GRANT SELECT, INSERT ON public.documents TO oi_pr2_api;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fire_door_deficiencies' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.fire_door_deficiencies FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fire_door_deficiencies' AND policyname = 'oi_pr2_api_insert') THEN
    CREATE POLICY oi_pr2_api_insert ON public.fire_door_deficiencies FOR INSERT TO oi_pr2_api WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fire_door_deficiencies' AND policyname = 'oi_pr2_api_update') THEN
    CREATE POLICY oi_pr2_api_update ON public.fire_door_deficiencies FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inspection_events' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.inspection_events FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inspection_events' AND policyname = 'oi_pr2_api_update') THEN
    CREATE POLICY oi_pr2_api_update ON public.inspection_events FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'documents' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.documents FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'documents' AND policyname = 'oi_pr2_api_insert') THEN
    CREATE POLICY oi_pr2_api_insert ON public.documents FOR INSERT TO oi_pr2_api WITH CHECK (true);
  END IF;
END $$;

-- ===== migrations/20261108180000_purchasing_api_policies.sql =====
-- DRAFT. NOT APPLIED to any hosted database.
-- A purchasing send inserted, then Postgres refused the follow-up:
-- oi_pr2_api has no UPDATE on purchasing_send_files (link_url),
-- no DELETE on purchasing_sends or purchasing_send_files (cleanup),
-- and no UPDATE on organizations (the company purchasing email).
-- Row security is on, so each grant also needs a policy.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    RETURN;
  END IF;

  GRANT SELECT, UPDATE, DELETE ON public.purchasing_send_files TO oi_pr2_api;
  GRANT SELECT, DELETE ON public.purchasing_sends TO oi_pr2_api;
  GRANT SELECT, UPDATE ON public.organizations TO oi_pr2_api;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchasing_send_files' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.purchasing_send_files FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchasing_send_files' AND policyname = 'oi_pr2_api_update') THEN
    CREATE POLICY oi_pr2_api_update ON public.purchasing_send_files FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchasing_send_files' AND policyname = 'oi_pr2_api_delete') THEN
    CREATE POLICY oi_pr2_api_delete ON public.purchasing_send_files FOR DELETE TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchasing_sends' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.purchasing_sends FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchasing_sends' AND policyname = 'oi_pr2_api_delete') THEN
    CREATE POLICY oi_pr2_api_delete ON public.purchasing_sends FOR DELETE TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.organizations FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'oi_pr2_api_update') THEN
    CREATE POLICY oi_pr2_api_update ON public.organizations FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ===== migrations/20261108181500_purchasing_api_insert_policies.sql =====
-- DRAFT. NOT APPLIED to any hosted database by this repo.
-- Staging already has these INSERT policies (applied as purchasing_api_insert_policies).
-- This copy is idempotent so a fresh database matches that correction and a
-- second run does not create them again.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    RETURN;
  END IF;

  GRANT INSERT ON public.purchasing_sends, public.purchasing_send_files TO oi_pr2_api;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchasing_sends' AND policyname = 'oi_pr2_api_insert') THEN
    CREATE POLICY oi_pr2_api_insert ON public.purchasing_sends FOR INSERT TO oi_pr2_api WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchasing_send_files' AND policyname = 'oi_pr2_api_insert') THEN
    CREATE POLICY oi_pr2_api_insert ON public.purchasing_send_files FOR INSERT TO oi_pr2_api WITH CHECK (true);
  END IF;
END $$;

-- ===== migrations/20261109170000_inspection_visits.sql =====
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

-- ===== migrations/20261109173000_inspection_visit_official_pdf.sql =====
-- DRAFT. NOT APPLIED to any hosted database.
-- Columns for the dated official combined-report PDF. Safe to run after the
-- visit table draft, and a no-op when that draft already created the columns.

ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_storage_key TEXT;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_sha256 TEXT;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_generated_at TIMESTAMPTZ;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_generated_by UUID REFERENCES users(id);
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_sent_at TIMESTAMPTZ;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_recipients TEXT;

-- ===== migrations/20261109190000_inspection_visits_policies.sql =====
-- DRAFT. NOT APPLIED to any hosted database.
-- inspection_visits enables row-level security in 20261109170000 and grants
-- oi_pr2_api, but that role has no policies. With rolbypassrls false, the
-- visit insert is rejected and the fire-door inspection transaction rolls back.
-- Tenant checks stay in the application queries (organization_id), the same
-- way the purchasing and fire-door API policies do. inspection_events.visit_id
-- is a column on a table that already has oi_pr2_api select and update policies.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    RETURN;
  END IF;

  GRANT SELECT, INSERT, UPDATE ON public.inspection_visits TO oi_pr2_api;

  DROP POLICY IF EXISTS oi_pr2_api_select ON public.inspection_visits;
  CREATE POLICY oi_pr2_api_select ON public.inspection_visits
    FOR SELECT TO oi_pr2_api
    USING (true);

  DROP POLICY IF EXISTS oi_pr2_api_insert ON public.inspection_visits;
  CREATE POLICY oi_pr2_api_insert ON public.inspection_visits
    FOR INSERT TO oi_pr2_api
    WITH CHECK (true);

  DROP POLICY IF EXISTS oi_pr2_api_update ON public.inspection_visits;
  CREATE POLICY oi_pr2_api_update ON public.inspection_visits
    FOR UPDATE TO oi_pr2_api
    USING (true)
    WITH CHECK (true);
END $$;

-- ===== migrations/20261111210000_company_dashboard_phase2.sql =====
-- Company dashboard phase 2. Additive and idempotent. Approved for the staging
-- database boaoedvyvifppuklbwad only. Do not apply to production bekaxmatcvxqpjixwsqn.
-- Existing openings, grants, estimates, and work orders are not deleted or rewritten.
-- A new approval_status column on replacement_estimates defaults to draft.

CREATE TABLE IF NOT EXISTS provider_accounts (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('facility', 'small', 'walkin')),
  customer_organization_id UUID REFERENCES organizations(id),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  notice_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'facility' OR customer_organization_id IS NOT NULL),
  CHECK (kind <> 'walkin' OR customer_organization_id IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_one_walkin
  ON provider_accounts (provider_organization_id)
  WHERE kind = 'walkin';

CREATE INDEX IF NOT EXISTS provider_accounts_provider
  ON provider_accounts (provider_organization_id, kind);

CREATE TABLE IF NOT EXISTS provider_account_sites (
  account_id UUID NOT NULL REFERENCES provider_accounts(id),
  property_id UUID NOT NULL REFERENCES properties(id),
  PRIMARY KEY (account_id, property_id)
);

CREATE INDEX IF NOT EXISTS provider_account_sites_property
  ON provider_account_sites (property_id);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocode_source TEXT;

ALTER TABLE replacement_estimates
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'draft';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'replacement_estimates_approval_status_check'
  ) THEN
    ALTER TABLE replacement_estimates ADD CONSTRAINT replacement_estimates_approval_status_check
      CHECK (approval_status IN ('draft', 'awaiting_approval', 'approved', 'declined'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS work_pickup_eligibility (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  work_kind TEXT NOT NULL CHECK (work_kind IN ('work_order', 'inspection', 'advised_repair')),
  work_id UUID NOT NULL,
  eligible BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (provider_organization_id, work_kind, work_id)
);

CREATE TABLE IF NOT EXISTS service_routes (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  service_date DATE NOT NULL,
  assigned_user_id UUID REFERENCES users(id),
  auto_approve_small_jobs BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_route_stops (
  id UUID PRIMARY KEY,
  route_id UUID NOT NULL REFERENCES service_routes(id),
  position INTEGER NOT NULL CHECK (position > 0),
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'declined')),
  work_kind TEXT NOT NULL CHECK (work_kind IN ('work_order', 'inspection', 'advised_repair')),
  work_id UUID NOT NULL,
  property_id UUID NOT NULL REFERENCES properties(id),
  time_window TEXT,
  drive_minutes INTEGER CHECK (drive_minutes IS NULL OR drive_minutes >= 0),
  requested_by_user_id UUID REFERENCES users(id),
  UNIQUE (route_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_route_stops_one_open_claim
  ON service_route_stops (work_kind, work_id)
  WHERE status IN ('requested', 'approved');

-- One Walk-in bucket per provider for every owned site whose name contains Walk-in.
INSERT INTO provider_accounts (id, provider_organization_id, kind, display_name)
SELECT gen_random_uuid(), owned.provider_id, 'walkin', 'Walk-in'
FROM (
  SELECT DISTINCT pf.organization_id AS provider_id
  FROM properties prop
  JOIN portfolios pf ON pf.id = prop.portfolio_id
  JOIN organizations org ON org.id = pf.organization_id
  WHERE org.org_type = 'service_partner'
    AND prop.name ~* '\ywalk[-\s]?in\y'
) owned
WHERE NOT EXISTS (
  SELECT 1 FROM provider_accounts existing
  WHERE existing.provider_organization_id = owned.provider_id AND existing.kind = 'walkin'
);

INSERT INTO provider_account_sites (account_id, property_id)
SELECT account.id, prop.id
FROM properties prop
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN organizations org ON org.id = pf.organization_id
JOIN provider_accounts account
  ON account.provider_organization_id = pf.organization_id AND account.kind = 'walkin'
WHERE org.org_type = 'service_partner'
  AND prop.name ~* '\ywalk[-\s]?in\y'
  AND NOT EXISTS (
    SELECT 1 FROM provider_account_sites linked
    JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
    WHERE linked.property_id = prop.id
      AND linked_account.provider_organization_id = pf.organization_id
  )
ON CONFLICT DO NOTHING;

-- Every other provider-owned site becomes its own Small account. The account id
-- is the property id, so running this again does not create a second account.
INSERT INTO provider_accounts (id, provider_organization_id, kind, display_name)
SELECT prop.id, pf.organization_id, 'small', left(trim(prop.name), 200)
FROM properties prop
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN organizations org ON org.id = pf.organization_id
WHERE org.org_type = 'service_partner'
  AND length(trim(prop.name)) > 0
  AND prop.name !~* '\ywalk[-\s]?in\y'
  AND NOT EXISTS (
    SELECT 1 FROM provider_account_sites linked
    JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
    WHERE linked.property_id = prop.id
      AND linked_account.provider_organization_id = pf.organization_id
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_account_sites (account_id, property_id)
SELECT account.id, prop.id
FROM properties prop
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN provider_accounts account ON account.id = prop.id AND account.kind = 'small'
WHERE NOT EXISTS (
  SELECT 1 FROM provider_account_sites linked
  JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
  WHERE linked.property_id = prop.id
    AND linked_account.provider_organization_id = account.provider_organization_id
)
ON CONFLICT DO NOTHING;

-- Active grants become facility accounts, one per provider and customer company.
INSERT INTO provider_accounts (id, provider_organization_id, kind, customer_organization_id, display_name)
SELECT gen_random_uuid(), grant_row.provider_organization_id, 'facility', grant_row.customer_id,
       COALESCE(NULLIF(left(trim(grant_row.customer_name), 200), ''), 'Facility account')
FROM (
  SELECT DISTINCT fpa.provider_organization_id, owner.id AS customer_id, owner.name AS customer_name
  FROM facility_provider_assignments fpa
  JOIN properties prop ON prop.id = fpa.property_id
  JOIN portfolios pf ON pf.id = prop.portfolio_id
  JOIN organizations owner ON owner.id = pf.organization_id
  WHERE fpa.revoked_at IS NULL AND owner.org_type = 'customer'
) grant_row
WHERE NOT EXISTS (
  SELECT 1 FROM provider_accounts existing
  WHERE existing.provider_organization_id = grant_row.provider_organization_id
    AND existing.kind = 'facility'
    AND existing.customer_organization_id = grant_row.customer_id
);

INSERT INTO provider_account_sites (account_id, property_id)
SELECT account.id, fpa.property_id
FROM facility_provider_assignments fpa
JOIN properties prop ON prop.id = fpa.property_id
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN organizations owner ON owner.id = pf.organization_id
JOIN provider_accounts account
  ON account.provider_organization_id = fpa.provider_organization_id
 AND account.kind = 'facility'
 AND account.customer_organization_id = owner.id
WHERE fpa.revoked_at IS NULL
  AND owner.org_type = 'customer'
  AND NOT EXISTS (
    SELECT 1 FROM provider_account_sites linked
    JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
    WHERE linked.property_id = fpa.property_id
      AND linked_account.provider_organization_id = fpa.provider_organization_id
  )
ON CONFLICT DO NOTHING;

ALTER TABLE provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_account_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_pickup_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_route_stops ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE tbl text; roles text; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles
  FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOREACH tbl IN ARRAY ARRAY['provider_accounts','provider_account_sites','work_pickup_eligibility','service_routes','service_route_stops'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', tbl);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %I FROM %s', tbl, roles); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO oi_pr2_api', tbl);
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'server_select') THEN
        EXECUTE format('CREATE POLICY server_select ON %I FOR SELECT TO oi_pr2_api USING (true)', tbl);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'server_insert') THEN
        EXECUTE format('CREATE POLICY server_insert ON %I FOR INSERT TO oi_pr2_api WITH CHECK (true)', tbl);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'server_update') THEN
        EXECUTE format('CREATE POLICY server_update ON %I FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true)', tbl);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Production RLS for tables this bundle creates. Existing prod_api_* policies are not dropped or replaced.
DO $prod$
DECLARE t text;
  new_tables text[] := ARRAY['recognition_runs','recognition_run_photos','recognition_usage_settings','recognition_safety_caps','recognition_usage_monthly','recognition_usage_reservations','opening_billable_periods','facility_provider_assignment_periods','reference_documents','reference_document_models','reference_pages','reference_conflicts','reference_products','reference_product_sources','reference_dimensions','reference_lookalike_groups','reference_lookalike_members','reference_lookalike_pairs','reference_assets','reference_releases','reference_release_items','recognition_run_records','recognition_run_record_outbox','recognition_access_denials','hardware_recognition_settings','hardware_recognition_daily_usage','hardware_recognition_tech_daily_usage','hardware_recognition_runs','hardware_recognition_run_photos','hardware_recognition_items','hardware_training_labels','purchasing_sends','purchasing_send_files','fire_door_deficiencies','inspection_visits','provider_accounts','provider_account_sites','work_pickup_eligibility','service_routes','service_route_stops'];
  delete_tables text[] := ARRAY['purchasing_sends','purchasing_send_files'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    RAISE EXCEPTION 'oi_pr2_api_missing';
  END IF;
  FOREACH t IN ARRAY new_tables LOOP
    IF to_regclass('public.'||t) IS NULL THEN
      RAISE EXCEPTION 'expected_table_missing: %', t;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO oi_pr2_api', t);
    IF t = ANY(delete_tables) THEN
      EXECUTE format('GRANT DELETE ON TABLE public.%I TO oi_pr2_api', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='prod_api_select') THEN
      EXECUTE format('CREATE POLICY prod_api_select ON public.%I FOR SELECT TO oi_pr2_api USING (true)', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='prod_api_insert') THEN
      EXECUTE format('CREATE POLICY prod_api_insert ON public.%I FOR INSERT TO oi_pr2_api WITH CHECK (true)', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='prod_api_update') THEN
      EXECUTE format('CREATE POLICY prod_api_update ON public.%I FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true)', t);
    END IF;
    IF t = ANY(delete_tables) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='prod_api_delete') THEN
      EXECUTE format('CREATE POLICY prod_api_delete ON public.%I FOR DELETE TO oi_pr2_api USING (true)', t);
    END IF;
  END LOOP;
END $prod$;

INSERT INTO public.schema_migrations (filename)
SELECT v.filename
FROM (VALUES
  ('016_password_reset.sql'),
  ('20261030090700_recognition_runs.sql'),
  ('20261030090800_recognition_budget_guard.sql'),
  ('20261030090900_recognition_revoke_public_access.sql'),
  ('20261030091000_reference_library.sql'),
  ('20261031090000_recognition_run_records.sql'),
  ('20261107130500_staff_mfa.sql'),
  ('20261107143000_staff_sign_in_codes.sql'),
  ('20261107203000_door_hardware_recognition.sql'),
  ('20261108143000_purchasing_department_email.sql'),
  ('20261108143100_nfpa80_fire_door_inspections.sql'),
  ('20261108150000_inspector_license_and_facility_contact.sql'),
  ('20261108160000_inspection_report_records.sql'),
  ('20261108171000_fire_door_api_policies.sql'),
  ('20261108180000_purchasing_api_policies.sql'),
  ('20261108181500_purchasing_api_insert_policies.sql'),
  ('20261109170000_inspection_visits.sql'),
  ('20261109173000_inspection_visit_official_pdf.sql'),
  ('20261109190000_inspection_visits_policies.sql'),
  ('20261111210000_company_dashboard_phase2.sql')
) AS v(filename)
WHERE NOT EXISTS (
  SELECT 1 FROM public.schema_migrations existing WHERE existing.filename = v.filename
);

COMMIT;
