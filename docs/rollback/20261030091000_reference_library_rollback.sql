-- Rollback for 20261030091000_reference_library (DRAFT; separate approval). Drops the library tables and the
-- two recognition_runs columns. Refuses if any release has been published (releases are evidence of what runs used).
DO $$ BEGIN
  IF to_regclass('reference_releases') IS NOT NULL AND EXISTS (SELECT 1 FROM reference_releases) THEN
    RAISE EXCEPTION 'reference_rollback_refused_releases_exist'; END IF;
END $$;
ALTER TABLE recognition_runs DROP COLUMN IF EXISTS reference_citations;
ALTER TABLE recognition_runs DROP COLUMN IF EXISTS reference_release_id;
DROP FUNCTION IF EXISTS reference_release_publish(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS reference_approve(UUID, UUID, TEXT, TEXT, TEXT);
DROP TABLE IF EXISTS reference_release_items, reference_releases, reference_assets, reference_lookalike_pairs,
  reference_lookalike_members, reference_lookalike_groups, reference_dimensions, reference_product_sources,
  reference_products, reference_conflicts, reference_pages, reference_document_models, reference_documents;
DROP FUNCTION IF EXISTS reference_release_immutable();
DROP FUNCTION IF EXISTS reference_documents_guard();
ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
    'org_created','first_admin_invited','facility_created','staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked',
    'org_parent_changed','membership_added','membership_removed',
    'usage_settings_changed','safety_cap_set','safety_cap_removed'));
