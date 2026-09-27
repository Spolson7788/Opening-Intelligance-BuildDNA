-- Extend the existing trusted server role, not public/client roles. Tenant and
-- administrator checks remain in the API, matching the existing role contract.
DO $$ DECLARE t text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  FOREACH t IN ARRAY ARRAY['company_branches','user_branch_assignments','facility_provider_assignments','component_purchasing_approvals'] LOOP
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO oi_pr2_api',t);
   EXECUTE format('CREATE POLICY oi_pr2_api_select ON public.%I FOR SELECT TO oi_pr2_api USING (true)',t);
   EXECUTE format('CREATE POLICY oi_pr2_api_insert ON public.%I FOR INSERT TO oi_pr2_api WITH CHECK (true)',t);
   EXECUTE format('CREATE POLICY oi_pr2_api_update ON public.%I FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true)',t);
  END LOOP;
  GRANT DELETE ON public.user_branch_assignments TO oi_pr2_api;
  CREATE POLICY oi_pr2_api_delete ON public.user_branch_assignments FOR DELETE TO oi_pr2_api USING(true);
 END IF;
END $$;
