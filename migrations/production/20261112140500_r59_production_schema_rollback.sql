-- Rolls back migrations/production/20261112140500_r59_production_schema.sql.
-- Drops objects that bundle adds. Does not drop password_reset_tokens, staff MFA tables,
-- staff_sign_in_codes, or any policy named prod_api_* on a table that existed before the bundle.
-- Does not restore a previous body for the NFPA delete guards: those functions are new on the
-- 2026-11-12 production dump, so rollback removes them.
-- Not applied to any hosted database by this commit.

BEGIN;

DROP TRIGGER IF EXISTS inspection_events_retain_three_years ON public.inspection_events;
DROP TRIGGER IF EXISTS photos_retain_deficiency_evidence ON public.photos;
DROP TRIGGER IF EXISTS opening_billable_periods_move ON public.buildings;
DROP TRIGGER IF EXISTS opening_billable_periods_move ON public.openings;
DROP TRIGGER IF EXISTS opening_billable_periods_move ON public.portfolios;
DROP TRIGGER IF EXISTS opening_billable_periods_move ON public.properties;
DROP TRIGGER IF EXISTS opening_billable_periods_track ON public.openings;
DROP TRIGGER IF EXISTS facility_provider_assignment_periods_track ON public.facility_provider_assignments;
DROP TRIGGER IF EXISTS facility_provider_assignments_provider_owned_guard ON public.facility_provider_assignments;

ALTER TABLE public.inspection_events DROP COLUMN IF EXISTS visit_id;
ALTER TABLE public.properties DROP COLUMN IF EXISTS geocoded_at;
ALTER TABLE public.properties DROP COLUMN IF EXISTS geocode_source;
ALTER TABLE public.properties DROP COLUMN IF EXISTS contact_email;
ALTER TABLE public.replacement_estimates DROP COLUMN IF EXISTS approval_status;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS purchasing_email;
ALTER TABLE public.company_branches DROP COLUMN IF EXISTS purchasing_email;
ALTER TABLE public.inspection_events DROP COLUMN IF EXISTS inspector_qualification;
ALTER TABLE public.inspection_events DROP COLUMN IF EXISTS inspector_license_number;
ALTER TABLE public.photos DROP COLUMN IF EXISTS inline_bytes;
ALTER TABLE public.documents DROP COLUMN IF EXISTS inspection_event_id;
ALTER TABLE public.documents DROP COLUMN IF EXISTS content;
ALTER TABLE public.documents DROP COLUMN IF EXISTS content_type;

DROP TABLE IF EXISTS public.service_route_stops CASCADE;
DROP TABLE IF EXISTS public.service_routes CASCADE;
DROP TABLE IF EXISTS public.work_pickup_eligibility CASCADE;
DROP TABLE IF EXISTS public.provider_account_sites CASCADE;
DROP TABLE IF EXISTS public.provider_accounts CASCADE;
DROP TABLE IF EXISTS public.purchasing_send_files CASCADE;
DROP TABLE IF EXISTS public.purchasing_sends CASCADE;
DROP TABLE IF EXISTS public.fire_door_deficiencies CASCADE;
DROP TABLE IF EXISTS public.inspection_visits CASCADE;
DROP TABLE IF EXISTS public.hardware_training_labels CASCADE;
DROP TABLE IF EXISTS public.hardware_recognition_items CASCADE;
DROP TABLE IF EXISTS public.hardware_recognition_run_photos CASCADE;
DROP TABLE IF EXISTS public.hardware_recognition_runs CASCADE;
DROP TABLE IF EXISTS public.hardware_recognition_tech_daily_usage CASCADE;
DROP TABLE IF EXISTS public.hardware_recognition_daily_usage CASCADE;
DROP TABLE IF EXISTS public.hardware_recognition_settings CASCADE;
DROP TABLE IF EXISTS public.recognition_access_denials CASCADE;
DROP TABLE IF EXISTS public.recognition_run_record_outbox CASCADE;
DROP VIEW IF EXISTS public.recognition_run_records_monthly;
DROP TABLE IF EXISTS public.recognition_run_records CASCADE;
DROP TABLE IF EXISTS public.recognition_run_photos CASCADE;
DROP TABLE IF EXISTS public.recognition_runs CASCADE;
DROP TABLE IF EXISTS public.reference_release_items CASCADE;
DROP TABLE IF EXISTS public.reference_releases CASCADE;
DROP TABLE IF EXISTS public.reference_assets CASCADE;
DROP TABLE IF EXISTS public.reference_lookalike_pairs CASCADE;
DROP TABLE IF EXISTS public.reference_lookalike_members CASCADE;
DROP TABLE IF EXISTS public.reference_lookalike_groups CASCADE;
DROP TABLE IF EXISTS public.reference_dimensions CASCADE;
DROP TABLE IF EXISTS public.reference_product_sources CASCADE;
DROP TABLE IF EXISTS public.reference_products CASCADE;
DROP TABLE IF EXISTS public.reference_conflicts CASCADE;
DROP TABLE IF EXISTS public.reference_pages CASCADE;
DROP TABLE IF EXISTS public.reference_document_models CASCADE;
DROP TABLE IF EXISTS public.reference_documents CASCADE;
DROP TABLE IF EXISTS public.opening_billable_periods CASCADE;
DROP TABLE IF EXISTS public.facility_provider_assignment_periods CASCADE;
DROP TABLE IF EXISTS public.recognition_usage_reservations CASCADE;
DROP TABLE IF EXISTS public.recognition_usage_monthly CASCADE;
DROP TABLE IF EXISTS public.recognition_safety_caps CASCADE;
DROP TABLE IF EXISTS public.recognition_usage_settings CASCADE;

DROP FUNCTION IF EXISTS public.prevent_early_deficiency_photo_delete();
DROP FUNCTION IF EXISTS public.prevent_early_inspection_delete();
DROP FUNCTION IF EXISTS public.billing_periods_guard();
DROP FUNCTION IF EXISTS public.facility_provider_assignment_periods_track();
DROP FUNCTION IF EXISTS public.facility_provider_assignments_provider_owned_guard();
DROP FUNCTION IF EXISTS public.opening_billable_periods_on_move();
DROP FUNCTION IF EXISTS public.opening_billable_periods_rehome(uuid[]);
DROP FUNCTION IF EXISTS public.opening_billable_periods_track();
DROP FUNCTION IF EXISTS public.recognition_access_denials_guard();
DROP FUNCTION IF EXISTS public.recognition_run_photos_guard();
DROP FUNCTION IF EXISTS public.recognition_run_record_outbox_guard();
DROP FUNCTION IF EXISTS public.recognition_run_record_outbox_reprocess(integer);
DROP FUNCTION IF EXISTS public.recognition_run_record_visible(uuid, uuid);
DROP FUNCTION IF EXISTS public.recognition_run_records_guard();
DROP FUNCTION IF EXISTS public.recognition_run_records_write(jsonb, boolean, numeric);
DROP FUNCTION IF EXISTS public.recognition_runs_guard();
DROP FUNCTION IF EXISTS public.recognition_runs_insert_guard();
DROP FUNCTION IF EXISTS public.recognition_safety_cap_set(uuid, uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.recognition_usage_reservations_guard();
DROP FUNCTION IF EXISTS public.recognition_usage_reserve(uuid);
DROP FUNCTION IF EXISTS public.recognition_usage_settings_update(uuid, uuid, text, integer, numeric, boolean, integer, numeric);
DROP FUNCTION IF EXISTS public.reference_approve(uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.reference_documents_guard();
DROP FUNCTION IF EXISTS public.reference_release_immutable();
DROP FUNCTION IF EXISTS public.reference_release_publish(uuid, uuid, text);

DROP POLICY IF EXISTS oi_pr2_api_insert ON public.documents;
DROP POLICY IF EXISTS oi_pr2_api_select ON public.documents;
DROP POLICY IF EXISTS oi_pr2_api_select ON public.inspection_events;
DROP POLICY IF EXISTS oi_pr2_api_update ON public.inspection_events;
DROP POLICY IF EXISTS oi_pr2_api_select ON public.organizations;
DROP POLICY IF EXISTS oi_pr2_api_update ON public.organizations;
REVOKE UPDATE ON TABLE public.inspection_events FROM oi_pr2_api;
REVOKE UPDATE ON TABLE public.organizations FROM oi_pr2_api;

DELETE FROM public.schema_migrations WHERE filename IN (
  '016_password_reset.sql',
  '20261030090700_recognition_runs.sql',
  '20261030090800_recognition_budget_guard.sql',
  '20261030090900_recognition_revoke_public_access.sql',
  '20261030091000_reference_library.sql',
  '20261031090000_recognition_run_records.sql',
  '20261107130500_staff_mfa.sql',
  '20261107143000_staff_sign_in_codes.sql',
  '20261107203000_door_hardware_recognition.sql',
  '20261108143000_purchasing_department_email.sql',
  '20261108143100_nfpa80_fire_door_inspections.sql',
  '20261108150000_inspector_license_and_facility_contact.sql',
  '20261108160000_inspection_report_records.sql',
  '20261108171000_fire_door_api_policies.sql',
  '20261108180000_purchasing_api_policies.sql',
  '20261108181500_purchasing_api_insert_policies.sql',
  '20261109170000_inspection_visits.sql',
  '20261109173000_inspection_visit_official_pdf.sql',
  '20261109190000_inspection_visits_policies.sql',
  '20261111210000_company_dashboard_phase2.sql'
);

COMMIT;
