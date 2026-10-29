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
