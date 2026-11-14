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
