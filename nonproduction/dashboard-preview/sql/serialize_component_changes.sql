CREATE FUNCTION public.lock_component_parent() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.assembly_id<>OLD.assembly_id OR NEW.facility_id<>OLD.facility_id OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'Component identity cannot be reassigned'; END IF;
 PERFORM 1 FROM public.opening_assemblies WHERE id=NEW.assembly_id AND facility_id=NEW.facility_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Opening unavailable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.lock_component_parent() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER component_parent_lock BEFORE INSERT OR UPDATE ON public.opening_components FOR EACH ROW EXECUTE FUNCTION public.lock_component_parent();
