

CREATE TABLE public.opening_assemblies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 facility_id uuid NOT NULL REFERENCES public.facilities(id),
 opening_no text NOT NULL CHECK (length(btrim(opening_no))>0),
 configuration text NOT NULL CHECK(configuration IN ('single','paired')),
 UNIQUE(facility_id,opening_no), UNIQUE(id,facility_id)
);
CREATE TABLE public.opening_structure (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 assembly_id uuid NOT NULL,
 facility_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('frame','active_leaf','inactive_leaf')),
 material text,
 FOREIGN KEY(assembly_id,facility_id) REFERENCES public.opening_assemblies(id,facility_id),
 UNIQUE(assembly_id,kind), UNIQUE(id,assembly_id,facility_id)
);
ALTER TABLE public.opening_assemblies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opening_structure ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.opening_assemblies,public.opening_structure FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.opening_assemblies,public.opening_structure TO authenticated;
CREATE POLICY assembly_read ON public.opening_assemblies FOR SELECT TO authenticated USING(public.is_member(facility_id));
CREATE POLICY assembly_insert ON public.opening_assemblies FOR INSERT TO authenticated WITH CHECK(public.can_write(facility_id));
CREATE POLICY assembly_update ON public.opening_assemblies FOR UPDATE TO authenticated USING(public.can_write(facility_id)) WITH CHECK(public.can_write(facility_id));
CREATE POLICY structure_read ON public.opening_structure FOR SELECT TO authenticated USING(public.is_member(facility_id));
CREATE POLICY structure_insert ON public.opening_structure FOR INSERT TO authenticated WITH CHECK(public.can_write(facility_id));
CREATE POLICY structure_update ON public.opening_structure FOR UPDATE TO authenticated USING(public.can_write(facility_id)) WITH CHECK(public.can_write(facility_id));
CREATE FUNCTION public.validate_opening_structure() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE config text;
BEGIN
 SELECT configuration INTO config FROM public.opening_assemblies WHERE id=NEW.assembly_id AND facility_id=NEW.facility_id FOR UPDATE;
 IF config IS NULL THEN RAISE EXCEPTION 'Opening assembly unavailable'; END IF;
 IF NEW.kind='inactive_leaf' AND config<>'paired' THEN RAISE EXCEPTION 'Inactive leaf requires paired opening'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_opening_structure() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER structure_validate BEFORE INSERT OR UPDATE ON public.opening_structure FOR EACH ROW EXECUTE FUNCTION public.validate_opening_structure();
CREATE FUNCTION public.prevent_assembly_reassignment() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.facility_id<>OLD.facility_id THEN RAISE EXCEPTION 'Assembly identity cannot change'; END IF;
 IF NEW.configuration='single' AND EXISTS(SELECT 1 FROM public.opening_structure WHERE assembly_id=OLD.id AND kind='inactive_leaf') THEN RAISE EXCEPTION 'Remove inactive leaf before changing configuration'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.prevent_assembly_reassignment() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assembly_validate BEFORE UPDATE ON public.opening_assemblies FOR EACH ROW EXECUTE FUNCTION public.prevent_assembly_reassignment();

CREATE TABLE public.opening_components (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 assembly_id uuid NOT NULL,
 facility_id uuid NOT NULL,
 structure_id uuid,
 component_class text NOT NULL CHECK(length(btrim(component_class))>0),
 manufacturer text,
 model text,
 condition text NOT NULL DEFAULT 'unverified' CHECK(condition IN ('unverified','good','worn','failed')),
 FOREIGN KEY(assembly_id,facility_id) REFERENCES public.opening_assemblies(id,facility_id),
 FOREIGN KEY(structure_id,assembly_id,facility_id) REFERENCES public.opening_structure(id,assembly_id,facility_id)
);
CREATE INDEX opening_components_parent ON public.opening_components(assembly_id,facility_id);
CREATE INDEX opening_components_structure ON public.opening_components(structure_id,assembly_id,facility_id);
ALTER TABLE public.opening_components ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.opening_components FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.opening_components TO authenticated;
CREATE POLICY component_read ON public.opening_components FOR SELECT TO authenticated USING(public.is_member(facility_id));
CREATE POLICY component_insert ON public.opening_components FOR INSERT TO authenticated WITH CHECK(public.can_write(facility_id));
CREATE POLICY component_update ON public.opening_components FOR UPDATE TO authenticated USING(public.can_write(facility_id)) WITH CHECK(public.can_write(facility_id));
