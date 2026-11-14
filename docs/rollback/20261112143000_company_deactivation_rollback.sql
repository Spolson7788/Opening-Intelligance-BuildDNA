-- Rolls back migrations/20261112143000_company_deactivation.sql.
-- Refuses when a company deactivation audit row exists, so the rollback does not delete audit history.
-- Does not delete companies, memberships, facilities, openings, photos, or provider assignments.

DO $$ BEGIN
  IF to_regclass('public.platform_audit_events') IS NOT NULL
     AND EXISTS (SELECT 1 FROM platform_audit_events WHERE action IN ('company_deactivated', 'company_reactivated')) THEN
    RAISE EXCEPTION 'company_deactivation_rollback_has_audit';
  END IF;
END $$;

DROP TABLE IF EXISTS organization_deactivation_memberships;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_deactivation_complete;
ALTER TABLE organizations DROP COLUMN IF EXISTS deactivation_reason;
ALTER TABLE organizations DROP COLUMN IF EXISTS deactivated_by_user_id;
ALTER TABLE organizations DROP COLUMN IF EXISTS deactivated_at;

CREATE OR REPLACE FUNCTION memberships_home_deactivates_user() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND NEW.is_home AND OLD.is_active AND NOT NEW.is_active THEN
    UPDATE users SET is_active = false WHERE id = NEW.user_id AND is_active;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION user_authorized_orgs(p_user UUID)
RETURNS TABLE (organization_id UUID, role TEXT, via_organization_id UUID, access TEXT)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  -- access: 'member' = own membership (normal rights for the role);
  --         'tree_admin' = child location via a parent admin (may create/edit);
  --         'tree_view'  = child location via a parent facilities_manager (VIEW ONLY: role reported as 'viewer').
  SELECT DISTINCT ON (x.id) x.id, x.role, x.via, x.access FROM (
    SELECT m.organization_id AS id, m.role, m.organization_id AS via, 'member' AS access, 0 AS pri
    FROM organization_memberships m JOIN users u ON u.id = m.user_id AND u.is_active
    WHERE m.user_id = p_user AND m.is_active
    UNION ALL
    SELECT d.id, CASE WHEN m.role = 'admin' THEN 'admin' ELSE 'viewer' END, m.organization_id,
           CASE WHEN m.role = 'admin' THEN 'tree_admin' ELSE 'tree_view' END,
           CASE WHEN m.role = 'admin' THEN 1 ELSE 2 END
    FROM organization_memberships m JOIN users u ON u.id = m.user_id AND u.is_active
    JOIN organizations o ON o.id = m.organization_id AND o.org_type IN ('customer','service_partner')
    CROSS JOIN LATERAL organization_subtree(m.organization_id) AS d(id)
    WHERE m.user_id = p_user AND m.is_active AND m.role IN ('admin','facilities_manager') AND d.id <> m.organization_id
  ) x ORDER BY x.id, x.pri
$$;

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
    'reference_document_approved','reference_product_approved','reference_dimension_verified','reference_lookalike_group_approved','reference_release_published',
    'staff_mfa_reset','staff_mfa_lockout_cleared'));
