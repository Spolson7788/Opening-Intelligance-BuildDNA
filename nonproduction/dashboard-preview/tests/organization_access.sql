BEGIN;
SELECT set_config('test.a',gen_random_uuid()::text,true),set_config('test.b',gen_random_uuid()::text,true),set_config('test.oa',gen_random_uuid()::text,true),set_config('test.ob',gen_random_uuid()::text,true),set_config('test.fa',gen_random_uuid()::text,true),set_config('test.fb',gen_random_uuid()::text,true);
INSERT INTO auth.users(id) VALUES(current_setting('test.a')::uuid),(current_setting('test.b')::uuid);
INSERT INTO public.organizations(id,code,name) VALUES(current_setting('test.oa')::uuid,'ROLLBACK-A','Rollback A'),(current_setting('test.ob')::uuid,'ROLLBACK-B','Rollback B');
INSERT INTO public.organization_memberships(organization_id,user_id,role) VALUES(current_setting('test.oa')::uuid,current_setting('test.a')::uuid,'admin'),(current_setting('test.ob')::uuid,current_setting('test.b')::uuid,'admin');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',current_setting('test.a'),true);
INSERT INTO public.facilities(id,name) VALUES(current_setting('test.fa')::uuid,'Rollback A facility');
DO $$ BEGIN
 IF NOT public.can_write(current_setting('test.fa')::uuid) THEN RAISE EXCEPTION 'A own write failed'; END IF;
 IF (SELECT count(*) FROM public.organizations)<>1 THEN RAISE EXCEPTION 'Org discovery leak'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub',current_setting('test.b'),true);
INSERT INTO public.facilities(id,name) VALUES(current_setting('test.fb')::uuid,'Rollback B facility');
DO $$ BEGIN
 IF public.is_member(current_setting('test.fa')::uuid) OR public.can_write(current_setting('test.fa')::uuid) OR EXISTS(SELECT 1 FROM public.facilities WHERE id=current_setting('test.fa')::uuid) THEN RAISE EXCEPTION 'B accessed A'; END IF;
 BEGIN
  INSERT INTO public.facilities(name,organization_id) VALUES('Attack',current_setting('test.oa')::uuid);
  RAISE EXCEPTION 'Cross-org facility create accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Organization administrator required' THEN RAISE; END IF; END;
 BEGIN
  INSERT INTO public.organization_memberships(organization_id,user_id,role) VALUES(current_setting('test.oa')::uuid,auth.uid(),'admin');
  RAISE EXCEPTION 'Self-enrollment accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO public.memberships(user_id,facility_id,organization_id,role) VALUES(auth.uid(),current_setting('test.fa')::uuid,current_setting('test.oa')::uuid,'admin');
  RAISE EXCEPTION 'Self facility enrollment accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 BEGIN
 INSERT INTO public.memberships(user_id,facility_id,organization_id,role) VALUES(current_setting('test.b')::uuid,current_setting('test.fa')::uuid,current_setting('test.ob')::uuid,'admin');
 RAISE EXCEPTION 'Cross-org association accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
UPDATE public.organization_memberships SET role='viewer' WHERE user_id=current_setting('test.a')::uuid;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',current_setting('test.a'),true);
DO $$ BEGIN
 IF NOT public.is_member(current_setting('test.fa')::uuid) OR public.can_write(current_setting('test.fa')::uuid) THEN RAISE EXCEPTION 'Organization role ceiling failed'; END IF;
END $$;
RESET ROLE;
DELETE FROM public.organization_memberships WHERE user_id=current_setting('test.a')::uuid;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 IF public.is_member(current_setting('test.fa')::uuid) OR EXISTS(SELECT 1 FROM public.facilities WHERE id=current_setting('test.fa')::uuid) THEN RAISE EXCEPTION 'Revoked creator retained access'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: organization discovery, atomic owner assignment, B-to-A denial, no client self-enrollment, cross-org FK rejection, organization role ceiling, immediate membership revocation. SQL role simulation only.' AS result;

