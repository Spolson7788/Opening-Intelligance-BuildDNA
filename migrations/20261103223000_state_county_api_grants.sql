-- The application connects as oi_pr2_api. The state/county migration created
-- objects that role cannot use. Same contract as
-- 20260926183557_api_branch_provider_privileges.sql: the trusted server role
-- may use the tables; tenant checks stay in the API. Skipped when the role
-- is absent (local databases that have not created it).

DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA oi_private TO oi_pr2_api;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA oi_private TO oi_pr2_api;

  GRANT SELECT ON public.us_states, public.us_counties TO oi_pr2_api;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'us_states' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.us_states FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'us_counties' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.us_counties FOR SELECT TO oi_pr2_api USING (true);
  END IF;

  FOREACH t IN ARRAY ARRAY['company_branch_areas', 'technician_areas'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO oi_pr2_api', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'oi_pr2_api_select') THEN
      EXECUTE format('CREATE POLICY oi_pr2_api_select ON public.%I FOR SELECT TO oi_pr2_api USING (true)', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'oi_pr2_api_insert') THEN
      EXECUTE format('CREATE POLICY oi_pr2_api_insert ON public.%I FOR INSERT TO oi_pr2_api WITH CHECK (true)', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'oi_pr2_api_update') THEN
      EXECUTE format('CREATE POLICY oi_pr2_api_update ON public.%I FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true)', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'oi_pr2_api_delete') THEN
      EXECUTE format('CREATE POLICY oi_pr2_api_delete ON public.%I FOR DELETE TO oi_pr2_api USING (true)', t);
    END IF;
  END LOOP;

  -- properties already limits this role to column updates (id, and the
  -- sharing flag). Location edits write only these three columns. Reading
  -- them, and the facility patch/coverage queries, also need the columns
  -- those statements reference (WHERE id, RETURNING id/name, city).
  GRANT SELECT (id, name, city, state, state_code, county_fips),
        UPDATE (state, state_code, county_fips)
    ON public.properties TO oi_pr2_api;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties' AND policyname = 'oi_pr2_api_select') THEN
    CREATE POLICY oi_pr2_api_select ON public.properties FOR SELECT TO oi_pr2_api USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties' AND policyname = 'oi_pr2_api_property_location') THEN
    CREATE POLICY oi_pr2_api_property_location ON public.properties FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
  END IF;
END $$;
