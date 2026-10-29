-- Roll back 20261030090500 first. Roll the code back first. Export parent links first (they are lost).
DROP TRIGGER IF EXISTS organizations_hierarchy_guard ON organizations;
DROP FUNCTION IF EXISTS organizations_hierarchy_guard();
DROP FUNCTION IF EXISTS organization_subtree(UUID);
DROP INDEX IF EXISTS organizations_parent;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_parent_not_self;
ALTER TABLE organizations DROP COLUMN IF EXISTS parent_organization_id;
-- Restore the C3 audit action list. Fails if org_parent_changed/membership_* events exist (audit is append-only):
-- in that case leave the wider constraint in place.
ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
    'org_created','first_admin_invited','facility_created',
    'staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked'));
