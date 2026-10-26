-- REVIEW ONLY. Do not execute without specific approval for boaoedvyvifppuklbwad.
-- Existing shared API role; API authorization supplies tenant isolation.
BEGIN;
SET LOCAL search_path=pg_catalog,public;
DO $$ DECLARE t text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api' AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'restricted_role_required'; END IF;
 FOREACH t IN ARRAY ARRAY['commercial_documents','commercial_document_versions','provider_catalog_items','provider_catalog_versions','replacement_estimates','replacement_estimate_versions','commercial_document_links','sandbox_budget_series','sandbox_budget_versions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity) THEN RAISE EXCEPTION 'RLS prerequisite missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND cmd='INSERT' AND 'oi_pr2_api'=ANY(roles)) THEN RAISE EXCEPTION 'review INSERT policy prerequisite'; END IF;
 END LOOP;
END $$;
GRANT INSERT ON public.commercial_documents,public.commercial_document_versions,public.provider_catalog_items,public.provider_catalog_versions,public.replacement_estimates,public.replacement_estimate_versions,public.commercial_document_links,public.sandbox_budget_series,public.sandbox_budget_versions TO oi_pr2_api;
GRANT UPDATE(head_version) ON public.commercial_documents,public.provider_catalog_items,public.replacement_estimates,public.sandbox_budget_series TO oi_pr2_api;
-- No estimate_reviews, plan/event/delivery, cost/invoice, browser, DELETE or BYPASSRLS grants.
-- Existing SELECT and lock permissions are prerequisites; verify actual policies separately.
COMMIT;
