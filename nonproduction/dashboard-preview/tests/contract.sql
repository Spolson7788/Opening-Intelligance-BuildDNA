BEGIN;
SELECT set_config('test.uid',gen_random_uuid()::text,true),set_config('test.other',gen_random_uuid()::text,true),set_config('test.fid',gen_random_uuid()::text,true),set_config('test.aid',gen_random_uuid()::text,true),set_config('test.cid',gen_random_uuid()::text,true),set_config('test.op',gen_random_uuid()::text,true);
INSERT INTO auth.users(id) VALUES(current_setting('test.uid')::uuid),(current_setting('test.other')::uuid);
SELECT set_config('test.product',gen_random_uuid()::text,true);
INSERT INTO public.approved_products(id,manufacturer,model,document_url,approved,demonstration_record) VALUES(current_setting('test.product')::uuid,'Synthetic brand','Synthetic model','https://example.invalid/synthetic-document',true,true);
SELECT set_config('test.org',gen_random_uuid()::text,true);
INSERT INTO public.organizations(id,code,name) VALUES(current_setting('test.org')::uuid,current_setting('test.org'),'Rollback-only organization');
INSERT INTO public.organization_memberships(organization_id,user_id,role) VALUES(current_setting('test.org')::uuid,current_setting('test.uid')::uuid,'admin');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',current_setting('test.uid'),true);
INSERT INTO public.facilities(id,name,address,city,state,postal_code) VALUES(current_setting('test.fid')::uuid,'Rollback-only paired test','Synthetic address','Phoenix','AZ','85001');
DO $$ BEGIN
 IF NOT public.can_write(current_setting('test.fid')::uuid) THEN RAISE EXCEPTION 'Creator membership missing'; END IF;
END $$;
INSERT INTO public.opening_assemblies(id,facility_id,opening_no,configuration) VALUES(current_setting('test.aid')::uuid,current_setting('test.fid')::uuid,'TEST-PAIR','paired');
INSERT INTO public.opening_structure(assembly_id,facility_id,kind,material,condition) SELECT current_setting('test.aid')::uuid,current_setting('test.fid')::uuid,kind,'Synthetic','good' FROM unnest(ARRAY['frame','active_leaf','inactive_leaf']) kind;
DO $$ DECLARE payload jsonb; r jsonb; a uuid:=current_setting('test.aid')::uuid; f uuid:=current_setting('test.fid')::uuid; op uuid:=current_setting('test.op')::uuid;
BEGIN
 payload:=jsonb_build_object('id',current_setting('test.cid'),'assembly_id',a,'facility_id',f,'product_id',current_setting('test.product'),'component_class','CLOSER','condition','worn','reviewed',true,'disposition','replace','manufacturer','Synthetic brand','model','Synthetic model','identity_source','technician_selected','document_url','https://example.invalid/synthetic-document');
 r:=public.oi_apply_operation(op,'component',payload);
 IF r->>'status'<>'applied' THEN RAISE EXCEPTION 'Initial operation failed'; END IF;
 r:=public.oi_apply_operation(op,'component',payload);
 IF r->>'status'<>'already_applied' OR (SELECT count(*) FROM public.opening_components WHERE assembly_id=a)<>1 THEN RAISE EXCEPTION 'Replay duplicated component'; END IF;
 BEGIN
 PERFORM public.oi_apply_operation(op,'component',payload||'{"model":"changed"}'::jsonb);
 RAISE EXCEPTION 'Changed replay accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Operation identity conflict' THEN RAISE; END IF; END;
 IF public.oi_purchasing_review(a)->>'status'<>'refused' THEN RAISE EXCEPTION 'Unfinished opening allowed'; END IF;
 PERFORM public.oi_apply_operation(gen_random_uuid(),'component',payload||jsonb_build_object('id',gen_random_uuid(),'condition','good','disposition','serviceable'));
 PERFORM public.oi_apply_operation(gen_random_uuid(),'component',payload||jsonb_build_object('id',gen_random_uuid(),'condition','worn','disposition','refused','identity_source','unresolved'));
 IF (SELECT count(*) FROM public.opening_components WHERE assembly_id=a)<>3 THEN RAISE EXCEPTION 'Same-class components overwritten'; END IF;
 PERFORM public.oi_finish_opening(a);
 r:=public.oi_purchasing_review(a);
 IF r->>'status'<>'review_only' OR jsonb_array_length(r->'eligible')<>1 OR jsonb_array_length(r->'excluded')<>2 THEN RAISE EXCEPTION 'Purchasing inclusion/exclusion failed: %',r; END IF;
 PERFORM public.oi_apply_operation(gen_random_uuid(),'component',payload||'{"document_url":"https://example.invalid/wrong-product"}'::jsonb);
 PERFORM public.oi_finish_opening(a);
 IF public.oi_purchasing_review(a)->>'status'<>'refused' THEN RAISE EXCEPTION 'Wrong document accepted'; END IF;
 PERFORM public.oi_apply_operation(gen_random_uuid(),'component',payload||'{"identity_source":"unresolved"}'::jsonb);
 IF public.oi_purchasing_review(a)->>'status'<>'refused' THEN RAISE EXCEPTION 'Changed opening remained complete'; END IF;
 PERFORM public.oi_finish_opening(a);
 IF public.oi_purchasing_review(a)->>'status'<>'refused' THEN RAISE EXCEPTION 'Unresolved replacement accepted'; END IF;
 BEGIN
 PERFORM public.oi_apply_operation(gen_random_uuid(),'photo',jsonb_build_object('id',gen_random_uuid(),'assembly_id',a,'facility_id',f,'storage_path','missing'));
 RAISE EXCEPTION 'Missing photo accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Upload not retained' THEN RAISE; END IF; END;
END $$;
SELECT set_config('request.jwt.claim.sub',current_setting('test.other'),true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.opening_assemblies WHERE id=current_setting('test.aid')::uuid) OR EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id=current_setting('test.aid')::uuid) THEN RAISE EXCEPTION 'Cross-facility access'; END IF;
 BEGIN
 PERFORM public.oi_apply_operation(gen_random_uuid(),'component',jsonb_build_object('facility_id',current_setting('test.fid'),'assembly_id',current_setting('test.aid')));
 RAISE EXCEPTION 'Cross-facility write allowed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Write access required' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
SELECT 'PASS: atomic facility ownership, address fields, component replay, conflict refusal, same-class retention, completion invalidation, purchasing eligibility/refusals, missing upload refusal, other-facility record/write denial. Rollback SQL simulation only.' AS result;
