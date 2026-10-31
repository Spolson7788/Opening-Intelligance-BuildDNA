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