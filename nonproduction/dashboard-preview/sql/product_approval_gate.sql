CREATE TABLE public.approved_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), manufacturer text NOT NULL, model text NOT NULL,
 document_url text NOT NULL CHECK(document_url ~ '^https://'), approved boolean NOT NULL DEFAULT false,
 demonstration_record boolean NOT NULL DEFAULT false
);
ALTER TABLE public.approved_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.approved_products FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.approved_products TO authenticated;
CREATE POLICY approved_product_read ON public.approved_products FOR SELECT TO authenticated USING(approved);
ALTER TABLE public.opening_components ADD COLUMN product_id uuid REFERENCES public.approved_products(id);

CREATE OR REPLACE FUNCTION public.oi_apply_operation(p_id uuid,p_kind text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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
  INSERT INTO public.opening_components(id,assembly_id,facility_id,structure_id,component_class,manufacturer,model,condition,reviewed,disposition,identity_source,document_url,repair_cost,work_completed_at,product_id)
  VALUES(c.id,a,f,c.structure_id,c.component_class,c.manufacturer,c.model,coalesce(c.condition,'unverified'),coalesce(c.reviewed,false),coalesce(c.disposition,'refused'),coalesce(c.identity_source,'unresolved'),c.document_url,c.repair_cost,c.work_completed_at,c.product_id)
  ON CONFLICT(id) DO UPDATE SET structure_id=excluded.structure_id,component_class=excluded.component_class,manufacturer=excluded.manufacturer,model=excluded.model,condition=excluded.condition,reviewed=excluded.reviewed,disposition=excluded.disposition,identity_source=excluded.identity_source,document_url=excluded.document_url,repair_cost=excluded.repair_cost,work_completed_at=excluded.work_completed_at,product_id=excluded.product_id WHERE opening_components.assembly_id=a AND opening_components.facility_id=f;
  GET DIAGNOSTICS n=ROW_COUNT; IF n<>1 THEN RAISE EXCEPTION 'Component identity conflict'; END IF;
 ELSIF p_kind='photo' THEN
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='opening-photos' AND name=p_payload->>'storage_path') THEN RAISE EXCEPTION 'Upload not retained'; END IF;
  INSERT INTO public.assembly_photos(id,assembly_id,facility_id,structure_id,component_id,storage_path) VALUES((p_payload->>'id')::uuid,a,f,(p_payload->>'structure_id')::uuid,(p_payload->>'component_id')::uuid,p_payload->>'storage_path');
 ELSE RAISE EXCEPTION 'Unsupported operation'; END IF;
 INSERT INTO public.sync_receipts(operation_id,facility_id,kind,payload) VALUES(p_id,f,p_kind,p_payload);
 RETURN jsonb_build_object('status','applied','operation_id',p_id);
END $$;

CREATE OR REPLACE FUNCTION public.oi_purchasing_review(p_assembly uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.opening_assemblies; complete boolean; eligible jsonb; excluded jsonb; unresolved boolean;
BEGIN
 SELECT * INTO a FROM public.opening_assemblies WHERE id=p_assembly FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Opening unavailable'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.opening_completion WHERE assembly_id=a.id AND snapshot=public.oi_opening_snapshot(a.id)) INTO complete;
 IF (SELECT count(*) FROM public.opening_structure WHERE assembly_id=a.id)<>(CASE WHEN a.configuration='paired' THEN 3 ELSE 2 END) OR EXISTS(SELECT 1 FROM public.opening_structure WHERE assembly_id=a.id AND condition='unverified') OR NOT EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=a.id) OR EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=a.id AND (NOT reviewed OR condition='unverified')) THEN complete:=false; END IF;
 IF NOT complete THEN RETURN jsonb_build_object('status','refused','reason','Complete and save the entire opening first','eligible','[]'::jsonb); END IF;
 SELECT EXISTS(SELECT 1 FROM public.opening_components c WHERE c.assembly_id=a.id AND c.disposition='replace' AND c.condition<>'good' AND (c.identity_source='unresolved' OR NOT EXISTS(SELECT 1 FROM public.approved_products p WHERE p.id=c.product_id AND p.approved AND p.manufacturer=c.manufacturer AND p.model=c.model AND p.document_url=c.document_url))) INTO unresolved;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'class',component_class,'manufacturer',manufacturer,'model',model,'identity_source',identity_source,'document_url',document_url)) FILTER(WHERE disposition='replace' AND condition<>'good'),'[]'::jsonb),coalesce(jsonb_agg(jsonb_build_object('id',id,'reason',CASE WHEN condition='good' OR disposition='serviceable' THEN 'Serviceable — excluded' ELSE 'Explicitly refused — excluded' END)) FILTER(WHERE disposition<>'replace' OR condition='good'),'[]'::jsonb) INTO eligible,excluded FROM public.opening_components WHERE assembly_id=a.id;
 RETURN jsonb_build_object('status',CASE WHEN unresolved THEN 'refused' WHEN jsonb_array_length(eligible)=0 THEN 'no_request' ELSE 'review_only' END,'reason',CASE WHEN unresolved THEN 'Replacement identity or document unresolved' ELSE 'Review only — nothing sent' END,'eligible',CASE WHEN unresolved THEN '[]'::jsonb ELSE eligible END,'excluded',excluded);
END $$;
