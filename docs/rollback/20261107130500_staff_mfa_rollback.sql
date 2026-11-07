-- Roll back the SEC-2 staff MFA tables. Do not apply unless Stephan approves the rollback.
-- Audit rows are kept. platform_staff_regrant is not involved.
-- Dropping these tables removes encrypted secrets and recovery-code hashes. It does not
-- by itself restore password-only staff access: the API still refuses staff powers without
-- an mfa-verified token. Roll the application back in the same approved step.
-- If any staff authenticator audit rows exist, the action check is left as-is so those rows stay valid.
-- Lockout-clear markers live in staff_mfa_attempts and are dropped with that table.

DROP TABLE IF EXISTS staff_mfa_attempts;
DROP TABLE IF EXISTS staff_mfa_recovery_codes;
DROP TABLE IF EXISTS staff_mfa_factors;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_audit_events WHERE action IN ('staff_mfa_reset', 'staff_mfa_lockout_cleared')) THEN
    ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
    ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
        'org_created','first_admin_invited','facility_created',
        'staff_granted','staff_revoked',
        'user_deactivated','user_reactivated','user_role_changed',
        'provider_assignment_requested','provider_assignment_request_approved',
        'provider_assignment_request_declined','provider_assignment_request_withdrawn',
        'provider_assignment_set','provider_assignment_revoked',
        'org_parent_changed','membership_added','membership_removed',
        'usage_settings_changed','safety_cap_set','safety_cap_removed',
        'reference_document_approved','reference_product_approved','reference_dimension_verified','reference_lookalike_group_approved','reference_release_published'));
  END IF;
END $$;
