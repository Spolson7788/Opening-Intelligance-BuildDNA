-- DRAFT (Oct 31 2026, approved milestone "recognition run records"). NOT APPLIED to any database.
-- Apply only with its own approval, after 20261030091000_reference_library.sql.
-- One row per photo per recognition attempt (run): company, facility, opening, photo, the matched
-- manufacturer / series / model with their confidence scores, OI's cost per photo (snapshot of
-- recognition_usage_settings.cost_per_photo_usd at write time), status and timestamp.
-- Status: 'succeeded' (provider answered; may have matched nothing), 'failed' (any failure, including
-- an unknown provider outcome) or 'blocked_by_cap' (the atomic emergency safety cap refused).
-- Thresholds (shown to customers; no shadow mode): manufacturer >= 0.5, series >= 0.5, model >= 0.6
-- plus a transcribed marking / evidence. A level is only stored with every level above it.
-- Append-only: rows are never updated or deleted (retained history).
-- RLS (server role oi_pr2_api; the acting user is set per transaction with
-- set_config('oi.actor_user_id', <user id>, true)):
--   * OI staff (is_platform_staff) see every row;
--   * active members of the facility owner company see every row at that facility;
--   * active members of the requesting company see its own rows only while that company still has
--     an active (non-revoked) provider assignment: revoked providers lose access to past records;
--   * no actor set -> no rows. The server may insert; nobody may update or delete.
CREATE TABLE IF NOT EXISTS recognition_run_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES recognition_runs(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),   -- requesting company
  property_id UUID NOT NULL REFERENCES properties(id),          -- facility
  opening_id UUID NOT NULL REFERENCES openings(id),
  photo_id UUID NOT NULL REFERENCES photos(id),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','blocked_by_cap')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),
  manufacturer TEXT, manufacturer_confidence NUMERIC(5,4),
  series TEXT, series_confidence NUMERIC(5,4),
  model TEXT, model_confidence NUMERIC(5,4),
  model_marking_evidence BOOLEAN NOT NULL DEFAULT false,
  provider_called BOOLEAN NOT NULL,
  cost_per_photo_usd NUMERIC(12,6) CHECK (cost_per_photo_usd IS NULL OR cost_per_photo_usd >= 0), -- NULL = cost not configured
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, photo_id),
  CONSTRAINT recognition_run_records_failure_explicit CHECK ((status <> 'succeeded') = (failure_code IS NOT NULL)),
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

CREATE OR REPLACE FUNCTION recognition_run_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recognition_run_records_append_only'; END $$;
DROP TRIGGER IF EXISTS recognition_run_records_guard ON recognition_run_records;
CREATE TRIGGER recognition_run_records_guard BEFORE UPDATE OR DELETE ON recognition_run_records
  FOR EACH ROW EXECUTE FUNCTION recognition_run_records_guard();

-- Visibility for the acting user (see header). SECURITY DEFINER so the check can read memberships,
-- assignments and staff rows that the caller itself cannot read.
CREATE OR REPLACE FUNCTION recognition_run_record_visible(p_org UUID, p_property UUID) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE raw TEXT := nullif(current_setting('oi.actor_user_id', true), ''); actor UUID; owner UUID;
BEGIN
  IF raw IS NULL OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  actor := raw::uuid;
  IF is_platform_staff(actor) THEN RETURN true; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = actor AND is_active) THEN RETURN false; END IF;
  SELECT pf.organization_id INTO owner FROM properties p JOIN portfolios pf ON pf.id = p.portfolio_id WHERE p.id = p_property;
  IF owner IS NOT NULL AND EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = actor AND m.organization_id = owner AND m.is_active) THEN
    RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = actor AND m.organization_id = p_org AND m.is_active)
     AND EXISTS (SELECT 1 FROM facility_provider_assignments f WHERE f.property_id = p_property
                  AND f.provider_organization_id = p_org AND f.revoked_at IS NULL);
END $$;
-- Supabase default privileges grant EXECUTE on new functions to anon/authenticated: remove them.
REVOKE ALL ON FUNCTION recognition_run_record_visible(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION recognition_run_records_guard() FROM PUBLIC;

ALTER TABLE recognition_run_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recognition_run_records_server_insert ON recognition_run_records;
DROP POLICY IF EXISTS recognition_run_records_scoped_select ON recognition_run_records;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    CREATE POLICY recognition_run_records_server_insert ON recognition_run_records FOR INSERT TO oi_pr2_api WITH CHECK (true);
    CREATE POLICY recognition_run_records_scoped_select ON recognition_run_records FOR SELECT TO oi_pr2_api
      USING (recognition_run_record_visible(organization_id, property_id));
    GRANT SELECT, INSERT ON recognition_run_records TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION recognition_run_record_visible(UUID, UUID) TO oi_pr2_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON recognition_run_records FROM anon;
    REVOKE ALL ON FUNCTION recognition_run_record_visible(UUID, UUID), recognition_run_records_guard() FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON recognition_run_records FROM authenticated;
    REVOKE ALL ON FUNCTION recognition_run_record_visible(UUID, UUID), recognition_run_records_guard() FROM authenticated; END IF;
END $$;

-- Monthly usage by company (OI staff report). security_invoker: the table's RLS applies to the
-- reader, so staff see every company and anyone else sees only what they could see row by row.
-- Company names are joined by the report (not here) so the view needs no extra grants.
-- Months are UTC calendar months. Cost counts only photos actually sent to the provider.
CREATE OR REPLACE VIEW recognition_run_records_monthly WITH (security_invoker = true) AS
SELECT date_trunc('month', r.recorded_at AT TIME ZONE 'UTC')::date AS period_month,
  r.organization_id,
  count(DISTINCT r.run_id)::int AS runs,
  count(*)::int AS photo_attempts,
  count(*) FILTER (WHERE r.status = 'succeeded')::int AS succeeded_photos,
  count(*) FILTER (WHERE r.status = 'failed')::int AS failed_photos,
  count(*) FILTER (WHERE r.status = 'blocked_by_cap')::int AS blocked_by_cap_photos,
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