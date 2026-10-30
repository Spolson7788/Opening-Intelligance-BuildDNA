-- 20261030120000 reference page linking (ioqfdcehnhnqpnqawwvo staging only; NOT applied until Stephan approves).
-- Insert-only linking of rendered page images + page text to an existing DRAFT reference document.
--  * Two SECURITY DEFINER functions OWNED BY the NOLOGIN insert-only role oi_reference_uploader.
--  * EXECUTE for service_role only (the Edge Function); explicitly revoked from PUBLIC/anon/authenticated
--    because Supabase default privileges grant EXECUTE on new functions.
--  * oi_reference_uploader gets SELECT+INSERT on reference_pages only, behind an RLS policy that forces
--    draft state (not citable, unverified, transcription 'none') and a draft parent. No UPDATE/DELETE anywhere.
--  * Exact duplicates are skipped (reported), any differing row for the same page is a conflict (nothing changes).
--  * No table, column, bucket or storage-policy changes.

GRANT SELECT, INSERT ON public.reference_pages TO oi_reference_uploader;

DROP POLICY IF EXISTS uploader_pages_read ON public.reference_pages;
CREATE POLICY uploader_pages_read ON public.reference_pages FOR SELECT TO oi_reference_uploader USING (true);
DROP POLICY IF EXISTS uploader_pages_insert_draft ON public.reference_pages;
CREATE POLICY uploader_pages_insert_draft ON public.reference_pages FOR INSERT TO oi_reference_uploader
  WITH CHECK (citable = false AND fraction_unverified = true AND transcription_status = 'none'
              AND image_key LIKE 'reference/%' AND image_key LIKE '%' || doc_sha256 || '%' AND image_key LIKE '%' || image_sha256 || '.png'
              AND EXISTS (SELECT 1 FROM public.reference_documents d WHERE d.sha256 = doc_sha256 AND d.status = 'draft'));

-- Pre-check: rate limit (page events only), draft parent, existing page. Returns the parent's storage key so the
-- route derives the image folder from the PDF's stored path (never guessed).
CREATE OR REPLACE FUNCTION public.reference_page_check(p_uploader TEXT, p_doc_sha256 TEXT, p_page_no INTEGER, p_image_sha256 TEXT,
  p_text_sha256 TEXT, p_limit_per_hour INTEGER)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n INTEGER; d RECORD; p RECORD;
BEGIN
  IF p_doc_sha256 !~ '^[0-9a-f]{64}$' OR p_image_sha256 !~ '^[0-9a-f]{64}$' OR p_text_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_sha256'; END IF;
  IF p_page_no IS NULL OR p_page_no < 1 OR p_page_no > 5000 THEN RAISE EXCEPTION 'invalid_page_no'; END IF;
  SELECT count(*) INTO n FROM reference_upload_events
    WHERE uploader = p_uploader AND outcome IN ('inserted','duplicate') AND detail->>'kind' = 'page' AND occurred_at > now() - interval '1 hour';
  IF n >= LEAST(GREATEST(COALESCE(p_limit_per_hour, 300), 1), 2000) THEN
    INSERT INTO reference_upload_events(uploader, outcome, sha256, detail) VALUES (p_uploader, 'rate_limited', p_image_sha256, jsonb_build_object('kind','page','count_last_hour', n));
    RETURN jsonb_build_object('rate_limited', true);
  END IF;
  SELECT sha256, status, storage_key, page_count INTO d FROM reference_documents WHERE sha256 = p_doc_sha256;
  IF NOT FOUND THEN RETURN jsonb_build_object('rate_limited', false, 'parent', NULL); END IF;
  SELECT image_sha256, text_sha256, image_key INTO p FROM reference_pages WHERE doc_sha256 = p_doc_sha256 AND page_no = p_page_no;
  RETURN jsonb_build_object('rate_limited', false,
    'parent', jsonb_build_object('sha256', d.sha256, 'status', d.status, 'storage_key', d.storage_key, 'page_count', d.page_count),
    'existing', CASE WHEN p IS NULL THEN NULL ELSE jsonb_build_object('image_sha256', p.image_sha256, 'text_sha256', p.text_sha256, 'image_key', p.image_key,
      'identical', p.image_sha256 IS NOT DISTINCT FROM p_image_sha256 AND p.text_sha256 = p_text_sha256) END);
END $$;

-- Register one verified page as a DRAFT page row. Re-validates everything; insert-only.
CREATE OR REPLACE FUNCTION public.reference_page_register(p_uploader TEXT, p_doc_sha256 TEXT, p_page_no INTEGER, p_text TEXT, p_text_sha256 TEXT,
  p_page_class TEXT, p_image_key TEXT, p_image_sha256 TEXT, p_byte_size BIGINT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d RECORD; p RECORD; ins TEXT; folder TEXT; pid TEXT;
BEGIN
  IF p_doc_sha256 !~ '^[0-9a-f]{64}$' OR p_image_sha256 !~ '^[0-9a-f]{64}$' OR p_text_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_sha256'; END IF;
  IF p_page_no IS NULL OR p_page_no < 1 OR p_page_no > 5000 THEN RAISE EXCEPTION 'invalid_page_no'; END IF;
  IF p_text IS NULL OR encode(sha256(convert_to(p_text, 'UTF8')), 'hex') <> p_text_sha256 THEN RAISE EXCEPTION 'text_sha256_mismatch'; END IF;
  SELECT sha256, status, storage_key, page_count INTO d FROM reference_documents WHERE sha256 = p_doc_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'parent_not_found'; END IF;
  IF d.status <> 'draft' THEN RAISE EXCEPTION 'parent_not_draft'; END IF;
  IF p_page_no > d.page_count THEN RAISE EXCEPTION 'page_no_exceeds_parent_page_count'; END IF;
  folder := substring(d.storage_key FROM '^reference/([^/]+)/' || p_doc_sha256 || '\.pdf$');
  IF folder IS NULL THEN RAISE EXCEPTION 'parent_storage_key_unexpected'; END IF;
  IF p_image_key <> 'reference/' || folder || '/' || p_doc_sha256 || '/p' || lpad(p_page_no::text, 3, '0') || '.' || p_image_sha256 || '.png' THEN
    RAISE EXCEPTION 'image_key_mismatch'; END IF;
  pid := 'sha256:' || p_doc_sha256 || '#p' || p_page_no;
  INSERT INTO reference_pages(doc_sha256, page_no, page_id, text, text_sha256, page_class, transcription_status, citable, fraction_unverified, image_key, image_sha256)
    VALUES (p_doc_sha256, p_page_no, pid, p_text, p_text_sha256, p_page_class, 'none', false, true, p_image_key, p_image_sha256)
    ON CONFLICT DO NOTHING RETURNING page_id INTO ins;
  IF ins IS NULL THEN
    SELECT image_sha256, text_sha256, image_key INTO p FROM reference_pages WHERE doc_sha256 = p_doc_sha256 AND page_no = p_page_no;
    IF FOUND AND p.image_sha256 IS NOT DISTINCT FROM p_image_sha256 AND p.text_sha256 = p_text_sha256 THEN
      INSERT INTO reference_upload_events(uploader, outcome, sha256, byte_size, content_type, storage_key, detail)
        VALUES (p_uploader, 'duplicate', p_image_sha256, p_byte_size, 'image/png', p_image_key, jsonb_build_object('kind','page','doc_sha256',p_doc_sha256,'page_no',p_page_no,'stage','register'));
      RETURN jsonb_build_object('inserted', false, 'duplicate', true);
    END IF;
    INSERT INTO reference_upload_events(uploader, outcome, sha256, byte_size, content_type, storage_key, detail)
      VALUES (p_uploader, 'rejected', p_image_sha256, p_byte_size, 'image/png', p_image_key, jsonb_build_object('kind','page','reason','page_conflict','doc_sha256',p_doc_sha256,'page_no',p_page_no));
    RETURN jsonb_build_object('inserted', false, 'conflict', true);
  END IF;
  INSERT INTO reference_upload_events(uploader, outcome, sha256, byte_size, content_type, storage_key, detail)
    VALUES (p_uploader, 'inserted', p_image_sha256, p_byte_size, 'image/png', p_image_key, jsonb_build_object('kind','page','doc_sha256',p_doc_sha256,'page_no',p_page_no));
  RETURN jsonb_build_object('inserted', true, 'page_id', pid, 'image_key', p_image_key);
END $$;

GRANT CREATE ON SCHEMA public TO oi_reference_uploader;
GRANT oi_reference_uploader TO CURRENT_USER; -- needed to hand ownership to the role (PG16+); revoked below
ALTER FUNCTION public.reference_page_check(TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER) OWNER TO oi_reference_uploader;
ALTER FUNCTION public.reference_page_register(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) OWNER TO oi_reference_uploader;
REVOKE CREATE ON SCHEMA public FROM oi_reference_uploader;
-- After the ownership change, Supabase's default EXECUTE grants are held with the new owner as grantor, so they must be
-- revoked AS the owner (a REVOKE by postgres is a silent no-op). Found on apply 2026-10-30 and fixed the same way on staging.
SET ROLE oi_reference_uploader;
REVOKE ALL ON FUNCTION public.reference_page_check(TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reference_page_register(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
RESET ROLE;
REVOKE oi_reference_uploader FROM CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.reference_page_check(TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.reference_page_register(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) TO service_role;

NOTIFY pgrst, 'reload schema';