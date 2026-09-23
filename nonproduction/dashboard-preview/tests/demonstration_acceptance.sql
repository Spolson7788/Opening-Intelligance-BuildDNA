BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','a6baefe7-4ee0-483e-b4d8-25edb34329c0',true);
DO $$ DECLARE r jsonb; BEGIN
 IF (SELECT count(*) FROM public.facilities)<>1 OR (SELECT count(*) FROM public.opening_assemblies)<>5 OR (SELECT count(*) FROM public.opening_components)<>8 THEN RAISE EXCEPTION 'A dataset visibility mismatch'; END IF;
 IF (SELECT count(*) FROM public.opening_structure WHERE assembly_id='91f2b6aa-6dcf-4e13-aaef-ce7f5155d730')<>3 THEN RAISE EXCEPTION 'Pair hierarchy mismatch'; END IF;
 IF (SELECT count(*) FROM public.opening_components WHERE assembly_id='91f2b6aa-6dcf-4e13-aaef-ce7f5155d730' AND component_class='DOOR_CLOSER')<>2 THEN RAISE EXCEPTION 'Repeated closers missing'; END IF;
 r:=public.oi_purchasing_review('91f2b6aa-6dcf-4e13-aaef-ce7f5155d730');
 IF r->>'status'<>'review_only' OR jsonb_array_length(r->'eligible')<>1 OR jsonb_array_length(r->'excluded')<>3 THEN RAISE EXCEPTION 'Eligibility mismatch'; END IF;
 IF public.oi_purchasing_review('3619fe74-1f13-49ef-a7a4-ce186853eae0')->>'status'<>'refused' THEN RAISE EXCEPTION 'Refusal mismatch'; END IF;
 IF (SELECT count(*) FROM public.service_events)<>1 OR (SELECT count(*) FROM public.service_requests)<>3 THEN RAISE EXCEPTION 'Service history mismatch'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','a2fc2800-0bb4-41bc-93eb-da853968d6bd',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.opening_assemblies WHERE id='91f2b6aa-6dcf-4e13-aaef-ce7f5155d730') OR EXISTS(SELECT 1 FROM public.opening_components WHERE assembly_id='91f2b6aa-6dcf-4e13-aaef-ce7f5155d730') OR EXISTS(SELECT 1 FROM public.service_events WHERE facility_id='d8466e9e-06a2-4d63-8981-43557758a421') THEN RAISE EXCEPTION 'B accessed exact A record'; END IF;
 IF (SELECT count(*) FROM public.opening_assemblies)<>1 THEN RAISE EXCEPTION 'B control record missing'; END IF;
 BEGIN
 PERFORM public.oi_apply_operation(gen_random_uuid(),'component',jsonb_build_object('facility_id','d8466e9e-06a2-4d63-8981-43557758a421','assembly_id','91f2b6aa-6dcf-4e13-aaef-ce7f5155d730'));
 RAISE EXCEPTION 'B write accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Write access required' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
SELECT 'PASS: persisted demonstration hierarchy, repeated products, completion, one eligible/three excluded, unresolved refusal, service history, exact A opening read/write denied to B. SQL role execution, not browser/JWT or photograph evidence.' AS result;
