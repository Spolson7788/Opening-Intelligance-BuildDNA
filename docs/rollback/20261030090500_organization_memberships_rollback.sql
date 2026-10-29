-- Roll the code back first. Export organization_memberships first (extra memberships are lost;
-- home memberships equal users.organization_id so nothing about current access is lost).
DROP VIEW IF EXISTS platform_provider_overview;
DROP VIEW IF EXISTS platform_facility_overview;
DROP TRIGGER IF EXISTS users_sync_home_membership ON users;
DROP TRIGGER IF EXISTS memberships_home_deactivates_user ON organization_memberships;
DROP FUNCTION IF EXISTS memberships_home_deactivates_user();
DROP FUNCTION IF EXISTS users_sync_home_membership();
-- Restore the pre-membership function bodies (from 20261030090000 / 20261030090200).
CREATE OR REPLACE FUNCTION platform_staff_internal_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u JOIN organizations o ON o.id = u.organization_id
                 WHERE u.id = NEW.user_id AND o.org_type = 'internal') THEN
    RAISE EXCEPTION 'platform_staff_must_be_internal';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.granted_at <> OLD.granted_at
      OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
      OR (OLD.revoked_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'platform_staff_grant_is_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION is_platform_staff(p_user UUID) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM platform_staff s JOIN users u ON u.id = s.user_id
    JOIN organizations o ON o.id = u.organization_id
    WHERE s.user_id = p_user AND s.revoked_at IS NULL AND u.is_active AND o.org_type = 'internal')
$$;
CREATE OR REPLACE FUNCTION user_history_actor_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'user_history_wrong_org';
  END IF;
  IF NEW.changed_by_user_id = NEW.user_id THEN RAISE EXCEPTION 'user_history_no_self_change'; END IF;
  IF NOT is_platform_staff(NEW.changed_by_user_id) AND NOT EXISTS (SELECT 1 FROM users
       WHERE id = NEW.changed_by_user_id AND organization_id = NEW.organization_id AND role = 'admin') THEN
    RAISE EXCEPTION 'user_history_actor_not_allowed';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION provider_assignment_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'provider_assignment_requests_no_delete'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM properties p JOIN portfolios f ON f.id = p.portfolio_id
                   JOIN users u ON u.organization_id = f.organization_id
                   WHERE p.id = NEW.property_id AND u.id = NEW.requested_by_user_id AND u.role = 'admin') THEN
      RAISE EXCEPTION 'provider_assignment_request_requester_not_facility_admin';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.provider_organization_id AND org_type = 'service_partner') THEN
      RAISE EXCEPTION 'provider_assignment_request_not_a_provider';
    END IF;
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'provider_assignment_request_must_start_pending'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'provider_assignment_request_closed'; END IF;
  IF NEW.id <> OLD.id OR NEW.property_id <> OLD.property_id OR NEW.provider_organization_id <> OLD.provider_organization_id
     OR NEW.action <> OLD.action OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.requested_at <> OLD.requested_at OR NEW.reason <> OLD.reason THEN
    RAISE EXCEPTION 'provider_assignment_request_immutable_fields';
  END IF;
  IF NEW.status IN ('approved','declined') AND NOT is_platform_staff(NEW.reviewed_by_user_id) THEN
    RAISE EXCEPTION 'provider_assignment_request_reviewer_must_be_oi_staff';
  END IF;
  RETURN NEW;
END $$;
DROP FUNCTION IF EXISTS can_export_tree(UUID, UUID);
DROP FUNCTION IF EXISTS user_authorized_orgs(UUID);
DROP TABLE IF EXISTS organization_memberships;
DROP FUNCTION IF EXISTS organization_memberships_no_delete();
