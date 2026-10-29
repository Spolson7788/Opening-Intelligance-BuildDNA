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
