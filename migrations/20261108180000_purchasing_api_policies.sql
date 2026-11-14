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
