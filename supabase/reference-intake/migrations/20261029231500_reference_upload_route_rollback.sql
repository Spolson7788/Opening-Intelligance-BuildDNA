-- Rollback for 20261029231500 (not applied; run only with approval). Keeps every uploaded document,
-- object and audit row: it only removes the route's functions, policies and grants.
DROP FUNCTION IF EXISTS public.reference_upload_check(TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.reference_upload_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.reference_upload_reject(TEXT, TEXT, TEXT, BIGINT, TEXT);
DROP POLICY IF EXISTS uploader_read ON public.reference_documents;
DROP POLICY IF EXISTS uploader_insert_draft ON public.reference_documents;
REVOKE ALL ON public.reference_documents FROM oi_reference_uploader;
-- reference_upload_events is retained (audit). The role is retained until its grants are reviewed.
