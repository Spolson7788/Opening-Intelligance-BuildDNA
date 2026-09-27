-- PostgreSQL requires UPDATE on at least one column for SELECT FOR UPDATE.
-- Permit row locking by the trusted API; prohibit actual updates under this policy.
GRANT UPDATE (id) ON public.properties TO oi_pr2_api;
CREATE POLICY oi_pr2_api_lock ON public.properties FOR UPDATE TO oi_pr2_api
 USING (true) WITH CHECK (false);
