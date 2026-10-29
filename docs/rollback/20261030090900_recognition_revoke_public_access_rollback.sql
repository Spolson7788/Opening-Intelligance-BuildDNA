-- Rollback for 20261030090900_recognition_revoke_public_access.sql.
-- Restores only the PostgreSQL default (EXECUTE to PUBLIC) on the trigger/guard functions. It does NOT
-- re-grant anon/authenticated: that access was never intended, and re-granting it would re-open
-- direct RPC calls to the SECURITY DEFINER staff functions. Run before the 090800 rollback if needed.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('billing_periods_guard','facility_provider_assignment_periods_track','facility_provider_assignments_provider_owned_guard',
      'opening_billable_periods_on_move','opening_billable_periods_track','recognition_run_photos_guard','recognition_runs_guard',
      'recognition_runs_insert_guard','recognition_usage_reservations_guard')
  LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.f); END LOOP;
END $$;
