-- Nonproduction demonstration fixture. Caller sets demo.user_a and demo.user_b to normally provisioned Auth user IDs.
-- Deliberately refuses to overwrite an existing dataset. No photo/media placeholders are inserted.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.organizations WHERE code LIKE 'STG-DASH-R1-%') THEN RAISE EXCEPTION 'Dataset already exists; inspect instead of reseeding'; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=current_setting('demo.user_a')::uuid AND email_confirmed_at IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=current_setting('demo.user_b')::uuid AND email_confirmed_at IS NOT NULL) THEN RAISE EXCEPTION 'Two confirmed preview accounts required'; END IF;
 IF current_setting('demo.user_a')=current_setting('demo.user_b') THEN RAISE EXCEPTION 'Separate accounts required'; END IF;
END $$;
SELECT set_config('demo.org_a',gen_random_uuid()::text,true),set_config('demo.org_b',gen_random_uuid()::text,true),set_config('demo.fac_a',gen_random_uuid()::text,true),set_config('demo.fac_b',gen_random_uuid()::text,true),set_config('demo.product',gen_random_uuid()::text,true);
INSERT INTO public.organizations(id,code,name) VALUES(current_setting('demo.org_a')::uuid,'STG-DASH-R1-ORG-A','Demonstration Organization A'),(current_setting('demo.org_b')::uuid,'STG-DASH-R1-ORG-B','Demonstration Organization B');
INSERT INTO public.organization_memberships(organization_id,user_id,role) VALUES(current_setting('demo.org_a')::uuid,current_setting('demo.user_a')::uuid,'admin'),(current_setting('demo.org_b')::uuid,current_setting('demo.user_b')::uuid,'admin');
-- Historical manufacturer-authored catalog, hosted by a distributor. Demo approval only; not physical identification.
INSERT INTO public.approved_products(id,manufacturer,model,document_url,approved,demonstration_record) VALUES(current_setting('demo.product')::uuid,'Cal-Royal','CR441','https://mrlock.com/content/441.pdf',true,true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',current_setting('demo.user_b'),true);
INSERT INTO public.facilities(id,name,address,city,state,postal_code,facility_type) VALUES(current_setting('demo.fac_b')::uuid,'STG-DASH-R1 — Organization B control','Synthetic address — not a real site','Phoenix','AZ','85001','Demonstration');
INSERT INTO public.opening_assemblies(facility_id,opening_no,configuration,area) VALUES(current_setting('demo.fac_b')::uuid,'B-CONTROL','single','Organization B denial-test control');
SELECT set_config('request.jwt.claim.sub',current_setting('demo.user_a'),true);
INSERT INTO public.facilities(id,name,address,city,state,postal_code,facility_type) VALUES(current_setting('demo.fac_a')::uuid,'STG-DASH-R1 — Valley Medical demonstration','Synthetic address — not a real site','Chandler','AZ','85225','Demonstration');
INSERT INTO public.opening_assemblies(facility_id,opening_no,configuration,area) VALUES
(current_setting('demo.fac_a')::uuid,'101-PAIR','paired','Demonstration: paired entrance'),
(current_setting('demo.fac_a')::uuid,'102-HEALTHY','single','Demonstration: completed service'),
(current_setting('demo.fac_a')::uuid,'103-MONITOR','single','Demonstration: monitor condition'),
(current_setting('demo.fac_a')::uuid,'104-UNASSESSED','single','Demonstration: assessment incomplete'),
(current_setting('demo.fac_a')::uuid,'105-REFUSED','single','Demonstration: critical condition, identity unresolved');
INSERT INTO public.opening_structure(assembly_id,facility_id,kind,material,condition)
SELECT a.id,a.facility_id,k.kind,'Hollow Metal',CASE WHEN a.opening_no='104-UNASSESSED' THEN 'unverified' ELSE 'good' END FROM public.opening_assemblies a CROSS JOIN (VALUES('frame'),('active_leaf'),('inactive_leaf')) k(kind) WHERE a.facility_id=current_setting('demo.fac_a')::uuid AND (k.kind<>'inactive_leaf' OR a.configuration='paired');
INSERT INTO public.opening_components(assembly_id,facility_id,structure_id,component_class,manufacturer,model,condition,reviewed,disposition,identity_source,document_url,product_id,repair_cost)
SELECT a.id,a.facility_id,s.id,'DOOR_CLOSER','Cal-Royal','CR441',CASE WHEN s.kind='active_leaf' THEN 'worn' ELSE 'good' END,true,CASE WHEN s.kind='active_leaf' THEN 'replace' ELSE 'serviceable' END,'technician_selected','https://mrlock.com/content/441.pdf',current_setting('demo.product')::uuid,CASE WHEN s.kind='active_leaf' THEN 250 ELSE 0 END FROM public.opening_assemblies a JOIN public.opening_structure s ON s.assembly_id=a.id WHERE a.facility_id=current_setting('demo.fac_a')::uuid AND a.opening_no='101-PAIR' AND s.kind IN ('active_leaf','inactive_leaf');
INSERT INTO public.opening_components(assembly_id,facility_id,structure_id,component_class,condition,reviewed,disposition,identity_source)
SELECT a.id,a.facility_id,s.id,v.class,v.condition,true,v.disposition,'unresolved' FROM public.opening_assemblies a JOIN public.opening_structure s ON s.assembly_id=a.id AND s.kind='active_leaf' CROSS JOIN (VALUES('HINGE','good','serviceable'),('EXIT_DEVICE','worn','refused')) v(class,condition,disposition) WHERE a.facility_id=current_setting('demo.fac_a')::uuid AND a.opening_no='101-PAIR';
INSERT INTO public.opening_components(assembly_id,facility_id,structure_id,component_class,condition,reviewed,disposition,identity_source,work_completed_at)
SELECT a.id,a.facility_id,s.id,'DOOR_CLOSER',CASE a.opening_no WHEN '102-HEALTHY' THEN 'good' WHEN '103-MONITOR' THEN 'worn' WHEN '105-REFUSED' THEN 'failed' ELSE 'unverified' END,a.opening_no<>'104-UNASSESSED',CASE WHEN a.opening_no='105-REFUSED' THEN 'replace' ELSE 'serviceable' END,'unresolved',CASE WHEN a.opening_no='102-HEALTHY' THEN current_date-2 ELSE NULL END FROM public.opening_assemblies a JOIN public.opening_structure s ON s.assembly_id=a.id AND s.kind='active_leaf' WHERE a.facility_id=current_setting('demo.fac_a')::uuid AND a.opening_no<>'101-PAIR';
SELECT public.oi_finish_opening(id) FROM public.opening_assemblies WHERE facility_id=current_setting('demo.fac_a')::uuid AND opening_no<>'104-UNASSESSED';
INSERT INTO public.service_requests(facility_id,opening_no,symptom,reported_by,reported_at,priority,status)
VALUES(current_setting('demo.fac_a')::uuid,'101-PAIR','DEMONSTRATION: active-leaf closer worn; replacement review pending','Synthetic technician',now()-interval '1 day','High','OPEN'),
(current_setting('demo.fac_a')::uuid,'105-REFUSED','DEMONSTRATION: failed closer; identity must be established before purchasing','Synthetic technician',now()-interval '2 days','Critical','OPEN'),
(current_setting('demo.fac_a')::uuid,'102-HEALTHY','DEMONSTRATION: adjustment requested','Synthetic technician',now()-interval '3 days','Routine','CLOSED');
INSERT INTO public.service_events(facility_id,opening_no,request_id,performed_at,work_performed,cost,cost_evidence,door_closes,door_latches,device_operates,evidence_captured,notes)
SELECT r.facility_id,r.opening_no,r.id,now()-interval '2 days','DEMONSTRATION: adjusted closing and latching speed; operation checked',85,'Synthetic demonstration estimate',true,true,true,false,'Synthetic service history; not a field inspection or compliance certification' FROM public.service_requests r WHERE r.facility_id=current_setting('demo.fac_a')::uuid AND r.opening_no='102-HEALTHY';
INSERT INTO public.service_observations(event_id,observation) SELECT id,'DEMONSTRATION: door closed and latched during simulated service check' FROM public.service_events WHERE facility_id=current_setting('demo.fac_a')::uuid;
DO $$ DECLARE p jsonb; a uuid; BEGIN
 SELECT id INTO a FROM public.opening_assemblies WHERE facility_id=current_setting('demo.fac_a')::uuid AND opening_no='101-PAIR';
 p:=public.oi_purchasing_review(a);
 IF p->>'status'<>'review_only' OR jsonb_array_length(p->'eligible')<>1 OR jsonb_array_length(p->'excluded')<>3 THEN RAISE EXCEPTION 'Paired purchasing fixture invalid: %',p; END IF;
 SELECT id INTO a FROM public.opening_assemblies WHERE facility_id=current_setting('demo.fac_a')::uuid AND opening_no='105-REFUSED';
 IF public.oi_purchasing_review(a)->>'status'<>'refused' THEN RAISE EXCEPTION 'Refusal fixture invalid'; END IF;
END $$;
COMMIT;

