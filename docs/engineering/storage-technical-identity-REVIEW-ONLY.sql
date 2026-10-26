-- REVIEW ONLY. NOT a migration. No hosted execution authorized by this file.
-- Replace this fixed placeholder only with the separately approved technical Auth user UUID:
-- 00000000-0000-4000-8000-000000000001
-- Target: boaoedvyvifppuklbwad; private bucket oi-video-workflows-media.
-- Requires existing authenticated privileges, RLS on storage.buckets/objects, and
-- installed storage.allow_only_operation(text). No role/grant/public-table changes.
-- Verify gateway supplies trusted operation context on the actual project before rollout.
-- Existing application-table privilege denial is a separate prerequisite; future grants
-- need re-review. These guards protect only Storage against permissive-policy broadening.
-- Authenticated REST only, never service_role/BYPASSRLS. No WORM guarantee.
-- Canonical lowercase UUID v1-v5 path matches the adapter's normalized output.
BEGIN;
DO $$ BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass)
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.buckets'::regclass)
 THEN RAISE EXCEPTION 'Storage RLS prerequisite missing'; END IF;
 IF to_regprocedure('storage.allow_only_operation(text)') IS NULL THEN
 RAISE EXCEPTION 'Storage operation helper missing'; END IF;
END $$;
CREATE POLICY oi_technical_bucket_read ON storage.buckets FOR SELECT TO authenticated
 USING ((select auth.uid())='00000000-0000-4000-8000-000000000001'::uuid
 AND id='oi-video-workflows-media' AND public=false AND storage.allow_only_operation('bucket.get'));
CREATE POLICY oi_technical_bucket_guard ON storage.buckets AS RESTRICTIVE FOR SELECT TO authenticated
 USING ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid
 OR (id='oi-video-workflows-media' AND public=false AND storage.allow_only_operation('bucket.get')));
CREATE POLICY oi_technical_bucket_insert_guard ON storage.buckets AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid);
CREATE POLICY oi_technical_bucket_update_guard ON storage.buckets AS RESTRICTIVE FOR UPDATE TO authenticated
 USING ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid)
 WITH CHECK ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid);
CREATE POLICY oi_technical_bucket_delete_guard ON storage.buckets AS RESTRICTIVE FOR DELETE TO authenticated
 USING ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid);
CREATE POLICY oi_technical_object_upload ON storage.objects FOR INSERT TO authenticated
 WITH CHECK ((select auth.uid())='00000000-0000-4000-8000-000000000001'::uuid
 AND bucket_id='oi-video-workflows-media'
 AND name ~ '^commercial-documents/v1/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'
 AND storage.allow_only_operation('object.upload'));
CREATE POLICY oi_technical_object_read ON storage.objects FOR SELECT TO authenticated
 USING ((select auth.uid())='00000000-0000-4000-8000-000000000001'::uuid
 AND bucket_id='oi-video-workflows-media'
 AND name ~ '^commercial-documents/v1/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'
 AND storage.allow_only_operation('object.get_authenticated'));
CREATE POLICY oi_technical_object_insert_guard ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid
 OR (bucket_id='oi-video-workflows-media'
 AND name ~ '^commercial-documents/v1/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'
 AND storage.allow_only_operation('object.upload')));
CREATE POLICY oi_technical_object_read_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
 USING ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid
 OR (bucket_id='oi-video-workflows-media'
 AND name ~ '^commercial-documents/v1/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'
 AND storage.allow_only_operation('object.get_authenticated')));
CREATE POLICY oi_technical_object_update_guard ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
 USING ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid)
 WITH CHECK ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid);
CREATE POLICY oi_technical_object_delete_guard ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
 USING ((select auth.uid()) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid);
COMMIT;
