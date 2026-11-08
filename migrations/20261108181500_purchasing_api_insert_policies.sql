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
