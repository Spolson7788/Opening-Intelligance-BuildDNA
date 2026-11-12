-- OI staff can deactivate a whole company without deleting its data.
-- Direct memberships of a deactivated company no longer authorize that company.
-- Parent-tree access and provider assignments are left unchanged on purpose.
-- The home-membership trigger does not deactivate the person in other companies
-- while oi.company_deactivation is on.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deactivated_by_user_id UUID REFERENCES users(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_deactivation_complete;
ALTER TABLE organizations ADD CONSTRAINT organizations_deactivation_complete CHECK (
  (deactivated_at IS NULL AND deactivated_by_user_id IS NULL AND deactivation_reason IS NULL)
  OR (deactivated_at IS NOT NULL AND deactivated_by_user_id IS NOT NULL
      AND deactivation_reason IS NOT NULL AND length(btrim(deactivation_reason)) > 0)
);

CREATE TABLE IF NOT EXISTS organization_deactivation_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  was_active BOOLEAN NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

ALTER TABLE organization_deactivation_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON organization_deactivation_memberships FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON organization_deactivation_memberships FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON organization_deactivation_memberships FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_deactivation_memberships TO oi_pr2_api;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_deactivation_memberships' AND policyname = 'oi_pr2_api_select') THEN
      CREATE POLICY oi_pr2_api_select ON organization_deactivation_memberships FOR SELECT TO oi_pr2_api USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_deactivation_memberships' AND policyname = 'oi_pr2_api_insert') THEN
      CREATE POLICY oi_pr2_api_insert ON organization_deactivation_memberships FOR INSERT TO oi_pr2_api WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_deactivation_memberships' AND policyname = 'oi_pr2_api_update') THEN
      CREATE POLICY oi_pr2_api_update ON organization_deactivation_memberships FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_deactivation_memberships' AND policyname = 'oi_pr2_api_delete') THEN
      CREATE POLICY oi_pr2_api_delete ON organization_deactivation_memberships FOR DELETE TO oi_pr2_api USING (true);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION memberships_home_deactivates_user() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF current_setting('oi.company_deactivation', true) = 'on' THEN
    RETURN NEW;
  END IF;
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
  -- Direct memberships skip a deactivated company. The tree branch is unchanged:
  -- a parent company keeps the access it already had to a child location.
  SELECT DISTINCT ON (x.id) x.id, x.role, x.via, x.access FROM (
    SELECT m.organization_id AS id, m.role, m.organization_id AS via, 'member' AS access, 0 AS pri
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id AND u.is_active
    JOIN organizations mo ON mo.id = m.organization_id AND mo.deactivated_at IS NULL
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
    'staff_mfa_reset','staff_mfa_lockout_cleared',
    'company_deactivated','company_reactivated'));
