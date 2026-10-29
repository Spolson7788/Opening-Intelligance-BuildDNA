-- Chat reference upload route for opening-intelligence-staging (ioqfdcehnhnqpnqawwvo) ONLY.
-- Approved by Stephan Olson, Oct 29 2026 3:18 PM MST (t151u). Insert-only: no approval, update,
-- overwrite or delete path exists for the uploader.
--
-- Design
--  * Dedicated NOLOGIN role oi_reference_uploader. It may SELECT reference_documents (for sha256
--    dedupe) and INSERT draft rows only (RLS policy), and INSERT/SELECT its own audit table. It has no
--    UPDATE/DELETE/TRUNCATE anywhere.
--  * Two SECURITY DEFINER functions OWNED BY that role, so even the definer cannot update or delete.
--    EXECUTE only for service_role (the Edge Function); revoked from PUBLIC/anon/authenticated.
--  * The Edge Function authenticates the caller with an uploader key that Stephan sets as a function
--    secret; the key never touches the database.
--  * Bucket oi-opening-media-pr2-private stays private. Only CSV and XLSX are added to its allowed
--    types (additive). No storage policies are added: anon/authenticated still have no access.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_reference_uploader') THEN
    CREATE ROLE oi_reference_uploader NOLOGIN NOINHERIT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.reference_upload_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploader TEXT NOT NULL CHECK (length(uploader) BETWEEN 1 AND 80),
  outcome TEXT NOT NULL CHECK (outcome IN ('inserted','duplicate','rejected','rate_limited')),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  byte_size BIGINT,
  content_type TEXT,
  storage_key TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS reference_upload_events_uploader_time ON public.reference_upload_events (uploader, occurred_at);
ALTER TABLE public.reference_upload_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reference_upload_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.reference_upload_events_id_seq FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA public TO oi_reference_uploader;
GRANT SELECT, INSERT ON public.reference_documents TO oi_reference_uploader;
GRANT SELECT, INSERT ON public.reference_upload_events TO oi_reference_uploader;
GRANT USAGE ON SEQUENCE public.reference_upload_events_id_seq TO oi_reference_uploader;

DROP POLICY IF EXISTS uploader_read ON public.reference_documents;
CREATE POLICY uploader_read ON public.reference_documents FOR SELECT TO oi_reference_uploader USING (true);
DROP POLICY IF EXISTS uploader_insert_draft ON public.reference_documents;
CREATE POLICY uploader_insert_draft ON public.reference_documents FOR INSERT TO oi_reference_uploader
  WITH CHECK (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL AND superseded_by IS NULL AND duplicate_of IS NULL
              AND storage_key LIKE 'reference/%' AND storage_key LIKE '%' || sha256 || '%');
DROP POLICY IF EXISTS uploader_events_insert ON public.reference_upload_events;
CREATE POLICY uploader_events_insert ON public.reference_upload_events FOR INSERT TO oi_reference_uploader WITH CHECK (true);
DROP POLICY IF EXISTS uploader_events_read ON public.reference_upload_events;
CREATE POLICY uploader_events_read ON public.reference_upload_events FOR SELECT TO oi_reference_uploader USING (true);

-- Pre-check: rate limit + existing record. Logs rate-limit refusals and duplicates.
CREATE OR REPLACE FUNCTION public.reference_upload_check(p_uploader TEXT, p_sha256 TEXT, p_limit_per_hour INTEGER)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n INTEGER; d RECORD;
BEGIN
  IF p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_sha256'; END IF;
  SELECT count(*) INTO n FROM reference_upload_events
    WHERE uploader = p_uploader AND outcome IN ('inserted','duplicate') AND occurred_at > now() - interval '1 hour';
  IF n >= LEAST(GREATEST(COALESCE(p_limit_per_hour, 300), 1), 2000) THEN
    INSERT INTO reference_upload_events(uploader, outcome, sha256, detail) VALUES (p_uploader, 'rate_limited', p_sha256, jsonb_build_object('count_last_hour', n));
    RETURN jsonb_build_object('rate_limited', true);
  END IF;
  SELECT sha256, status, manufacturer, title, doc_type INTO d FROM reference_documents WHERE sha256 = p_sha256;
  IF FOUND THEN
    INSERT INTO reference_upload_events(uploader, outcome, sha256, detail) VALUES (p_uploader, 'duplicate', p_sha256, jsonb_build_object('stage', 'precheck'));
    RETURN jsonb_build_object('rate_limited', false, 'existing', jsonb_build_object('sha256', d.sha256, 'status', d.status, 'manufacturer', d.manufacturer, 'title', d.title, 'doc_type', d.doc_type));
  END IF;
  RETURN jsonb_build_object('rate_limited', false, 'existing', NULL);
END $$;

-- Register the uploaded object as a DRAFT document. Insert-only; a concurrent duplicate returns the existing row.
CREATE OR REPLACE FUNCTION public.reference_upload_register(p_uploader TEXT, p_sha256 TEXT, p_manufacturer TEXT, p_brand TEXT, p_title TEXT,
  p_doc_type TEXT, p_page_count INTEGER, p_storage_key TEXT, p_metadata JSONB, p_byte_size BIGINT, p_content_type TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ins TEXT; d RECORD;
BEGIN
  IF p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_sha256'; END IF;
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN RAISE EXCEPTION 'invalid_metadata'; END IF;
  INSERT INTO reference_documents(sha256, manufacturer, brand, title, doc_type, page_count, storage_key, metadata, status)
    VALUES (p_sha256, p_manufacturer, p_brand, p_title, p_doc_type, p_page_count, p_storage_key,
            p_metadata || jsonb_build_object('uploaded_by', p_uploader, 'upload_route', 'reference-upload', 'uploaded_at', now()), 'draft')
    ON CONFLICT (sha256) DO NOTHING RETURNING sha256 INTO ins;
  IF ins IS NULL THEN
    SELECT sha256, status, manufacturer, title, doc_type INTO d FROM reference_documents WHERE sha256 = p_sha256;
    INSERT INTO reference_upload_events(uploader, outcome, sha256, byte_size, content_type, storage_key, detail)
      VALUES (p_uploader, 'duplicate', p_sha256, p_byte_size, p_content_type, p_storage_key, jsonb_build_object('stage', 'register'));
    RETURN jsonb_build_object('inserted', false, 'existing', jsonb_build_object('sha256', d.sha256, 'status', d.status, 'manufacturer', d.manufacturer, 'title', d.title, 'doc_type', d.doc_type));
  END IF;
  INSERT INTO reference_upload_events(uploader, outcome, sha256, byte_size, content_type, storage_key, detail)
    VALUES (p_uploader, 'inserted', p_sha256, p_byte_size, p_content_type, p_storage_key, jsonb_build_object('manufacturer', p_manufacturer, 'doc_type', p_doc_type));
  RETURN jsonb_build_object('inserted', true, 'sha256', p_sha256, 'status', 'draft', 'storage_key', p_storage_key);
END $$;

-- Records a refused request (bad type, size, hash mismatch, metadata) for the audit trail.
CREATE OR REPLACE FUNCTION public.reference_upload_reject(p_uploader TEXT, p_reason TEXT, p_sha256 TEXT, p_byte_size BIGINT, p_content_type TEXT)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO reference_upload_events(uploader, outcome, sha256, byte_size, content_type, detail)
  VALUES (p_uploader, 'rejected', CASE WHEN p_sha256 ~ '^[0-9a-f]{64}$' THEN p_sha256 END, p_byte_size, left(p_content_type, 120), jsonb_build_object('reason', left(p_reason, 120)));
$$;

-- Ownership: the definer is the insert-only role. (CREATE on public is needed only to take ownership.)
GRANT CREATE ON SCHEMA public TO oi_reference_uploader;
GRANT oi_reference_uploader TO CURRENT_USER; -- needed to hand ownership to the role (PG16+); revoked below
ALTER FUNCTION public.reference_upload_check(TEXT, TEXT, INTEGER) OWNER TO oi_reference_uploader;
ALTER FUNCTION public.reference_upload_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, BIGINT, TEXT) OWNER TO oi_reference_uploader;
ALTER FUNCTION public.reference_upload_reject(TEXT, TEXT, TEXT, BIGINT, TEXT) OWNER TO oi_reference_uploader;
REVOKE CREATE ON SCHEMA public FROM oi_reference_uploader;
REVOKE oi_reference_uploader FROM CURRENT_USER;

REVOKE ALL ON FUNCTION public.reference_upload_check(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reference_upload_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reference_upload_reject(TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reference_upload_check(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.reference_upload_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reference_upload_reject(TEXT, TEXT, TEXT, BIGINT, TEXT) TO service_role;

-- Additive: allow CSV and XLSX in the private bucket. Visibility and size limit unchanged.
UPDATE storage.buckets
   SET allowed_mime_types = (SELECT array_agg(DISTINCT m ORDER BY m) FROM unnest(COALESCE(allowed_mime_types, '{}') ||
        ARRAY['text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) m)
 WHERE id = 'oi-opening-media-pr2-private' AND public = false AND allowed_mime_types IS NOT NULL;

NOTIFY pgrst, 'reload schema';
