-- Rollback for 20261030120000 (not applied; run only with approval). Keeps every page row, object and audit row.
DROP FUNCTION IF EXISTS public.reference_page_check(TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.reference_page_register(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT);
DROP POLICY IF EXISTS uploader_pages_read ON public.reference_pages;
DROP POLICY IF EXISTS uploader_pages_insert_draft ON public.reference_pages;
REVOKE ALL ON public.reference_pages FROM oi_reference_uploader;