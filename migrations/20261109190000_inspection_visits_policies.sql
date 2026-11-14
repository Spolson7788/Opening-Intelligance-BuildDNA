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
