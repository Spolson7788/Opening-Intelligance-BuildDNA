-- Isolated preview only; empty facility/membership baseline required.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.facilities) OR EXISTS(SELECT 1 FROM public.memberships)
 THEN RAISE EXCEPTION 'Existing facilities require an explicit organization backfill'; END IF;
END $$;
CREATE TABLE public.organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE public.organization_memberships(
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 user_id uuid NOT NULL REFERENCES auth.users(id),
 role public.member_role NOT NULL DEFAULT 'viewer',
 PRIMARY KEY(organization_id,user_id));
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organizations,public.organization_memberships FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.organizations,public.organization_memberships TO authenticated;
CREATE POLICY own_org_membership ON public.organization_memberships FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY own_organization ON public.organizations FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.organization_memberships m WHERE m.organization_id=id AND m.user_id=auth.uid()));
CREATE INDEX organization_memberships_user ON public.organization_memberships(user_id,organization_id);

ALTER TABLE public.facilities ADD COLUMN organization_id uuid NOT NULL REFERENCES public.organizations(id);
ALTER TABLE public.facilities ADD CONSTRAINT facility_org_pair UNIQUE(id,organization_id);
ALTER TABLE public.memberships ADD COLUMN organization_id uuid NOT NULL;
ALTER TABLE public.memberships ADD CONSTRAINT membership_facility_org FOREIGN KEY(facility_id,organization_id) REFERENCES public.facilities(id,organization_id);
ALTER TABLE public.memberships ADD CONSTRAINT membership_org_user FOREIGN KEY(organization_id,user_id) REFERENCES public.organization_memberships(organization_id,user_id) ON DELETE CASCADE;
CREATE INDEX memberships_org_user ON public.memberships(organization_id,user_id);
CREATE INDEX facilities_org ON public.facilities(organization_id);

CREATE OR REPLACE FUNCTION public.is_member(fid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.memberships m JOIN public.organization_memberships om ON om.organization_id=m.organization_id AND om.user_id=m.user_id WHERE m.facility_id=fid AND m.user_id=auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.oi_is_member(fac uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT public.is_member(fac); $$;
CREATE OR REPLACE FUNCTION public.can_write(fid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.memberships m JOIN public.organization_memberships om ON om.organization_id=m.organization_id AND om.user_id=m.user_id WHERE m.facility_id=fid AND m.user_id=auth.uid() AND m.role IN ('admin','tech') AND om.role IN ('admin','tech'));
$$;
CREATE FUNCTION public.assign_facility_organization() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'Facility ownership is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF auth.uid() IS NULL OR NEW.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Authenticated creator required'; END IF;
 IF NEW.organization_id IS NULL THEN
  SELECT count(*) INTO n FROM public.organization_memberships WHERE user_id=auth.uid() AND role='admin';
  IF n<>1 THEN RAISE EXCEPTION 'Select one authorized organization'; END IF;
  SELECT organization_id INTO NEW.organization_id FROM public.organization_memberships WHERE user_id=auth.uid() AND role='admin';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE organization_id=NEW.organization_id AND user_id=auth.uid() AND role='admin') THEN RAISE EXCEPTION 'Organization administrator required'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.assign_facility_organization() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assign_facility_org BEFORE INSERT OR UPDATE ON public.facilities FOR EACH ROW EXECUTE FUNCTION public.assign_facility_organization();
CREATE OR REPLACE FUNCTION public.link_new_facility_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NEW.created_by IS DISTINCT FROM auth.uid() OR NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=auth.uid() AND organization_id=NEW.organization_id AND role='admin') THEN RAISE EXCEPTION 'Organization administrator required'; END IF;
 INSERT INTO public.memberships(user_id,facility_id,role,organization_id) VALUES(auth.uid(),NEW.id,'admin',NEW.organization_id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.link_new_facility_owner() FROM PUBLIC,anon,authenticated;
DROP POLICY "member or creator can read facility" ON public.facilities;
ALTER POLICY facility_create ON public.facilities WITH CHECK(created_by=auth.uid() AND EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=auth.uid() AND organization_id=facilities.organization_id AND role='admin'));
ALTER POLICY mem_read ON public.memberships USING(user_id=auth.uid() AND EXISTS(SELECT 1 FROM public.organization_memberships om WHERE om.user_id=auth.uid() AND om.organization_id=memberships.organization_id));
