-- Isolated preview only. No production or R8 changes.
ALTER TABLE public.facilities ADD COLUMN city text, ADD COLUMN state text, ADD COLUMN postal_code text;
DROP POLICY "authed can insert facilities" ON public.facilities;
CREATE POLICY facility_create ON public.facilities FOR INSERT TO authenticated WITH CHECK(created_by=auth.uid());
CREATE FUNCTION public.link_new_facility_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NEW.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Authenticated creator required'; END IF;
 INSERT INTO public.memberships(user_id,facility_id,role) VALUES(auth.uid(),NEW.id,'admin');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.link_new_facility_owner() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER link_facility_owner AFTER INSERT ON public.facilities FOR EACH ROW EXECUTE FUNCTION public.link_new_facility_owner();

ALTER TABLE public.opening_assemblies ADD COLUMN area text, ADD COLUMN fire_rated boolean NOT NULL DEFAULT false;
ALTER TABLE public.opening_structure ADD COLUMN condition text NOT NULL DEFAULT 'unverified' CHECK(condition IN ('unverified','good','worn','failed'));
ALTER TABLE public.opening_components ADD COLUMN reviewed boolean NOT NULL DEFAULT false,
 ADD COLUMN disposition text NOT NULL DEFAULT 'refused' CHECK(disposition IN ('replace','serviceable','refused')),
 ADD COLUMN identity_source text NOT NULL DEFAULT 'unresolved' CHECK(identity_source IN ('unresolved','technician_selected','document_verified')),
 ADD COLUMN document_url text,
 ADD COLUMN repair_cost numeric CHECK(repair_cost>=0),
 ADD COLUMN work_completed_at date,
 ADD CONSTRAINT component_parent_unique UNIQUE(id,assembly_id,facility_id);

CREATE TABLE public.assembly_photos (
 id uuid PRIMARY KEY, assembly_id uuid NOT NULL, facility_id uuid NOT NULL,
 structure_id uuid, component_id uuid, storage_path text NOT NULL UNIQUE,
 taken_at timestamptz NOT NULL DEFAULT now(), taken_by uuid NOT NULL DEFAULT auth.uid(),
 CHECK(NOT (structure_id IS NOT NULL AND component_id IS NOT NULL)),
 CHECK(storage_path=facility_id::text||'/'||assembly_id::text||'/'||id::text),
 FOREIGN KEY(assembly_id,facility_id) REFERENCES public.opening_assemblies(id,facility_id),
 FOREIGN KEY(structure_id,assembly_id,facility_id) REFERENCES public.opening_structure(id,assembly_id,facility_id),
 FOREIGN KEY(component_id,assembly_id,facility_id) REFERENCES public.opening_components(id,assembly_id,facility_id)
);
CREATE TABLE public.sync_receipts (
 operation_id uuid PRIMARY KEY, actor_id uuid NOT NULL DEFAULT auth.uid(),
 facility_id uuid NOT NULL REFERENCES public.facilities(id), kind text NOT NULL,
 payload jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.opening_completion (
 assembly_id uuid PRIMARY KEY REFERENCES public.opening_assemblies(id),
 facility_id uuid NOT NULL REFERENCES public.facilities(id),
 snapshot jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(), completed_by uuid NOT NULL DEFAULT auth.uid()
);
ALTER TABLE public.assembly_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opening_completion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assembly_photos,public.sync_receipts,public.opening_completion FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.assembly_photos,public.sync_receipts TO authenticated;
GRANT SELECT,INSERT,UPDATE ON public.opening_completion TO authenticated;
CREATE POLICY photo_read ON public.assembly_photos FOR SELECT TO authenticated USING(public.is_member(facility_id));
CREATE POLICY photo_insert ON public.assembly_photos FOR INSERT TO authenticated WITH CHECK(public.can_write(facility_id) AND taken_by=auth.uid());
CREATE POLICY receipt_read ON public.sync_receipts FOR SELECT TO authenticated USING(actor_id=auth.uid() AND public.is_member(facility_id));
CREATE POLICY receipt_insert ON public.sync_receipts FOR INSERT TO authenticated WITH CHECK(actor_id=auth.uid() AND public.can_write(facility_id));
CREATE POLICY completion_read ON public.opening_completion FOR SELECT TO authenticated USING(public.is_member(facility_id));
CREATE POLICY completion_insert ON public.opening_completion FOR INSERT TO authenticated WITH CHECK(public.can_write(facility_id) AND completed_by=auth.uid());
CREATE POLICY completion_update ON public.opening_completion FOR UPDATE TO authenticated USING(public.can_write(facility_id)) WITH CHECK(public.can_write(facility_id) AND completed_by=auth.uid());

CREATE FUNCTION public.oi_opening_snapshot(p_assembly uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('assembly',to_jsonb(a),'structure',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.opening_structure s WHERE s.assembly_id=a.id),'[]'::jsonb),'components',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.opening_components c WHERE c.assembly_id=a.id),'[]'::jsonb)) FROM public.opening_assemblies a WHERE a.id=p_assembly;
$$;
CREATE FUNCTION public.oi_finish_opening(p_assembly uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.opening_assemblies; expected integer;
BEGIN
 SELECT * INTO a FROM public.opening_assemblies WHERE id=p_assembly FOR UPDATE;
 IF a.id IS NULL OR NOT public.can_write(a.facility_id) THEN RAISE EXCEPTION 'Opening unavailable'; END IF;
 expected:=CASE WHEN a.configuration='paired' THEN 3 ELSE 2 END;
 IF (SELECT count(*) FROM public.opening_structure WHERE assembly_id=a.id)<>expected THEN RAISE EXCEPTION 'Frame and every leaf required'; END IF;
 IF EXISTS(SELECT 1 FROM public.opening_structure WHERE assembly_id=a.id AND condition='unverified') THEN RAISE EXCEPTION 'Review frame and leaves'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=a.id) OR EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=a.id AND (NOT reviewed OR condition='unverified')) THEN RAISE EXCEPTION 'Review every component'; END IF;
 INSERT INTO public.opening_completion(assembly_id,facility_id,snapshot) VALUES(a.id,a.facility_id,public.oi_opening_snapshot(a.id)) ON CONFLICT(assembly_id) DO UPDATE SET snapshot=excluded.snapshot,completed_by=auth.uid(),completed_at=now();
 RETURN jsonb_build_object('status','completed');
END $$;
CREATE FUNCTION public.oi_purchasing_review(p_assembly uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.opening_assemblies; complete boolean; eligible jsonb; excluded jsonb; unresolved boolean;
BEGIN
 SELECT * INTO a FROM public.opening_assemblies WHERE id=p_assembly;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Opening unavailable'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.opening_completion WHERE assembly_id=a.id AND snapshot=public.oi_opening_snapshot(a.id)) INTO complete;
 IF (SELECT count(*) FROM public.opening_structure WHERE assembly_id=a.id)<>(CASE WHEN a.configuration='paired' THEN 3 ELSE 2 END) OR EXISTS(SELECT 1 FROM public.opening_structure WHERE assembly_id=a.id AND condition='unverified') OR NOT EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=a.id) OR EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=a.id AND (NOT reviewed OR condition='unverified')) THEN complete:=false; END IF;
 IF NOT complete THEN RETURN jsonb_build_object('status','refused','reason','Complete and save the entire opening first','eligible','[]'::jsonb); END IF;
 SELECT EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=a.id AND disposition='replace' AND (identity_source='unresolved' OR nullif(btrim(manufacturer),'') IS NULL OR nullif(btrim(model),'') IS NULL OR coalesce(document_url,'') !~ '^https://')) INTO unresolved;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'class',component_class,'manufacturer',manufacturer,'model',model,'identity_source',identity_source,'document_url',document_url)) FILTER(WHERE disposition='replace' AND condition<>'good'),'[]'::jsonb),coalesce(jsonb_agg(jsonb_build_object('id',id,'reason',CASE WHEN condition='good' OR disposition='serviceable' THEN 'Serviceable — excluded' ELSE 'Explicitly refused — excluded' END)) FILTER(WHERE disposition<>'replace' OR condition='good'),'[]'::jsonb) INTO eligible,excluded FROM public.opening_components WHERE assembly_id=a.id;
 RETURN jsonb_build_object('status',CASE WHEN unresolved THEN 'refused' WHEN jsonb_array_length(eligible)=0 THEN 'no_request' ELSE 'review_only' END,'reason',CASE WHEN unresolved THEN 'Replacement identity or document unresolved' ELSE 'Review only — nothing sent' END,'eligible',CASE WHEN unresolved THEN '[]'::jsonb ELSE eligible END,'excluded',excluded);
END $$;

CREATE FUNCTION public.oi_apply_operation(p_id uuid,p_kind text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f uuid:=(p_payload->>'facility_id')::uuid; a uuid:=(p_payload->>'assembly_id')::uuid; r public.sync_receipts; c public.opening_components; n integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.can_write(f) THEN RAISE EXCEPTION 'Write access required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 SELECT * INTO r FROM public.sync_receipts WHERE operation_id=p_id;
 IF FOUND THEN
  IF r.kind<>p_kind OR r.payload<>p_payload THEN RAISE EXCEPTION 'Operation identity conflict'; END IF;
  RETURN jsonb_build_object('status','already_applied','operation_id',p_id);
 END IF;
 PERFORM 1 FROM public.opening_assemblies WHERE id=a AND facility_id=f FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Opening unavailable'; END IF;
 IF p_kind='component' THEN
  c:=jsonb_populate_record(NULL::public.opening_components,p_payload);
  INSERT INTO public.opening_components(id,assembly_id,facility_id,structure_id,component_class,manufacturer,model,condition,reviewed,disposition,identity_source,document_url,repair_cost,work_completed_at)
  VALUES(c.id,a,f,c.structure_id,c.component_class,c.manufacturer,c.model,coalesce(c.condition,'unverified'),coalesce(c.reviewed,false),coalesce(c.disposition,'refused'),coalesce(c.identity_source,'unresolved'),c.document_url,c.repair_cost,c.work_completed_at)
  ON CONFLICT(id) DO UPDATE SET structure_id=excluded.structure_id,component_class=excluded.component_class,manufacturer=excluded.manufacturer,model=excluded.model,condition=excluded.condition,reviewed=excluded.reviewed,disposition=excluded.disposition,identity_source=excluded.identity_source,document_url=excluded.document_url,repair_cost=excluded.repair_cost,work_completed_at=excluded.work_completed_at WHERE opening_components.assembly_id=a AND opening_components.facility_id=f;
  GET DIAGNOSTICS n=ROW_COUNT; IF n<>1 THEN RAISE EXCEPTION 'Component identity conflict'; END IF;
 ELSIF p_kind='photo' THEN
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='opening-photos' AND name=p_payload->>'storage_path') THEN RAISE EXCEPTION 'Upload not retained'; END IF;
  INSERT INTO public.assembly_photos(id,assembly_id,facility_id,structure_id,component_id,storage_path) VALUES((p_payload->>'id')::uuid,a,f,(p_payload->>'structure_id')::uuid,(p_payload->>'component_id')::uuid,p_payload->>'storage_path');
 ELSE RAISE EXCEPTION 'Unsupported operation'; END IF;
 INSERT INTO public.sync_receipts(operation_id,facility_id,kind,payload) VALUES(p_id,f,p_kind,p_payload);
 RETURN jsonb_build_object('status','applied','operation_id',p_id);
END $$;
REVOKE ALL ON FUNCTION public.oi_opening_snapshot(uuid),public.oi_finish_opening(uuid),public.oi_purchasing_review(uuid),public.oi_apply_operation(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.oi_opening_snapshot(uuid),public.oi_finish_opening(uuid),public.oi_purchasing_review(uuid),public.oi_apply_operation(uuid,text,jsonb) TO authenticated;
CREATE INDEX assembly_photos_parent ON public.assembly_photos(assembly_id,facility_id);
CREATE INDEX sync_receipts_actor ON public.sync_receipts(actor_id,facility_id);
