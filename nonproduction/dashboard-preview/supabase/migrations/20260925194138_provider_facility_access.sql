-- Additive, isolated connected-preview extension. No domain-based auto-enrollment.
-- Provision these associations through a trusted administrator, never a browser key.
CREATE TABLE public.service_providers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(btrim(name)<>''),
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.provider_memberships (
 provider_id uuid NOT NULL REFERENCES public.service_providers(id),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 role public.member_role NOT NULL DEFAULT 'viewer', active boolean NOT NULL DEFAULT true,
 home_state text CHECK(home_state IS NULL OR home_state ~ '^[A-Z]{2}$'),
 approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider_id,user_id)
);
CREATE INDEX provider_memberships_user ON public.provider_memberships(user_id,provider_id);
CREATE TABLE public.facility_provider_assignments (
 facility_id uuid NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
 provider_id uuid NOT NULL REFERENCES public.service_providers(id),
 active boolean NOT NULL DEFAULT true, allow_write boolean NOT NULL DEFAULT false,
 territory text, assigned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(facility_id,provider_id)
);
CREATE INDEX facility_provider_assignments_provider ON public.facility_provider_assignments(provider_id,facility_id);
ALTER TABLE public.service_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facility_provider_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_providers,public.provider_memberships,public.facility_provider_assignments FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.service_providers,public.provider_memberships,public.facility_provider_assignments TO authenticated;
GRANT ALL ON public.service_providers,public.provider_memberships,public.facility_provider_assignments TO service_role;
CREATE POLICY provider_membership_self ON public.provider_memberships FOR SELECT TO authenticated
 USING(user_id=(select auth.uid()) AND active);
CREATE POLICY provider_self ON public.service_providers FOR SELECT TO authenticated
 USING(active AND EXISTS(SELECT 1 FROM public.provider_memberships m WHERE m.provider_id=id AND m.user_id=(select auth.uid()) AND m.active));
CREATE POLICY provider_assignment_read ON public.facility_provider_assignments FOR SELECT TO authenticated
 USING(active AND EXISTS(SELECT 1 FROM public.provider_memberships m JOIN public.service_providers p ON p.id=m.provider_id WHERE m.provider_id=facility_provider_assignments.provider_id AND m.user_id=(select auth.uid()) AND m.active AND p.active));

-- All authorization uses current database rows, not editable user metadata or stale JWT roles.
-- Existing explicit CUSTOMER organization permissions remain independent of provider grants.
CREATE OR REPLACE FUNCTION public.is_member(fid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (
 EXISTS(SELECT 1 FROM public.memberships m JOIN public.organization_memberships om ON om.organization_id=m.organization_id AND om.user_id=m.user_id WHERE m.facility_id=fid AND m.user_id=auth.uid())
 OR EXISTS(SELECT 1 FROM public.facility_provider_assignments a JOIN public.provider_memberships m ON m.provider_id=a.provider_id JOIN public.service_providers p ON p.id=a.provider_id WHERE a.facility_id=fid AND m.user_id=auth.uid() AND a.active AND m.active AND p.active));
$$;
CREATE OR REPLACE FUNCTION public.can_write(fid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (
 EXISTS(SELECT 1 FROM public.memberships m JOIN public.organization_memberships om ON om.organization_id=m.organization_id AND om.user_id=m.user_id WHERE m.facility_id=fid AND m.user_id=auth.uid() AND m.role IN ('admin','tech') AND om.role IN ('admin','tech'))
 OR EXISTS(SELECT 1 FROM public.facility_provider_assignments a JOIN public.provider_memberships m ON m.provider_id=a.provider_id JOIN public.service_providers p ON p.id=a.provider_id WHERE a.facility_id=fid AND m.user_id=auth.uid() AND a.active AND a.allow_write AND m.active AND p.active AND m.role IN ('admin','tech')));
$$;
CREATE OR REPLACE FUNCTION public.oi_is_member(fac uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT public.is_member(fac); $$;
REVOKE ALL ON FUNCTION public.is_member(uuid),public.can_write(uuid),public.oi_is_member(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_member(uuid),public.can_write(uuid),public.oi_is_member(uuid) TO authenticated;
-- Legacy inspection policies used direct customer memberships; route through the same rule.
ALTER POLICY inspections_read ON public.inspections USING(public.is_member(facility_id));
ALTER POLICY inspections_insert ON public.inspections WITH CHECK(public.can_write(facility_id));
-- Existing storage, hierarchy, service and queue policies already call these helpers.
-- Facilities stay with their original owner organization; no backfill or reassignment occurs.
