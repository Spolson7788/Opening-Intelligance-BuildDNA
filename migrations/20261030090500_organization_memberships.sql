-- One account, several companies (DRAFT, not applied).
-- Backfill: exactly one membership per existing user = users.organization_id / role / is_active,
-- so every current user keeps exactly today's access. users.organization_id stays as the
-- "home" company (legacy code keeps working); a trigger keeps the home membership in sync.
-- Email domain never grants membership. Provider access to facilities still needs an active
-- facility_provider_assignments row; state is only a filter.
CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('admin','facilities_manager','technician','inspector','viewer')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_home BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, -- NULL = backfill / home sync
  deactivated_at TIMESTAMPTZ,
  deactivated_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  deactivation_reason TEXT,
  UNIQUE (user_id, organization_id),
  CHECK (is_active OR deactivated_at IS NOT NULL OR is_home)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_one_home ON organization_memberships (user_id) WHERE is_home;
CREATE INDEX IF NOT EXISTS organization_memberships_org ON organization_memberships (organization_id) WHERE is_active;

INSERT INTO organization_memberships (user_id, organization_id, role, is_active, is_home)
SELECT id, organization_id, role, is_active, true FROM users
ON CONFLICT (user_id, organization_id) DO NOTHING;

CREATE OR REPLACE FUNCTION organization_memberships_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'organization_memberships_no_delete'; END $$;
CREATE TRIGGER organization_memberships_no_delete BEFORE DELETE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION organization_memberships_no_delete();

-- Keep the home membership equal to the legacy users columns.
-- Deactivating a person (users.is_active -> false) deactivates EVERY membership in every company.
-- Reactivation restores only the home membership; other companies must re-add the person.
CREATE OR REPLACE FUNCTION users_sync_home_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    UPDATE organization_memberships SET is_home = false, is_active = false, deactivated_at = now(),
      deactivation_reason = 'home company changed' WHERE user_id = NEW.id AND is_home;
  END IF;
  INSERT INTO organization_memberships (user_id, organization_id, role, is_active, is_home)
  VALUES (NEW.id, NEW.organization_id, NEW.role, NEW.is_active, true)
  ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active,
    is_home = true, deactivated_at = CASE WHEN EXCLUDED.is_active THEN NULL ELSE COALESCE(organization_memberships.deactivated_at, now()) END;
  IF NOT NEW.is_active THEN
    UPDATE organization_memberships SET is_active = false, deactivated_at = COALESCE(deactivated_at, now()),
      deactivation_reason = COALESCE(deactivation_reason, 'person deactivated')
    WHERE user_id = NEW.id AND is_active;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_sync_home_membership AFTER INSERT OR UPDATE OF organization_id, role, is_active ON users
  FOR EACH ROW EXECUTE FUNCTION users_sync_home_membership();

-- Deactivating the home membership deactivates the person (and so all memberships).
-- Removing someone from a non-home company only ends that one membership.
CREATE OR REPLACE FUNCTION memberships_home_deactivates_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND NEW.is_home AND OLD.is_active AND NOT NEW.is_active THEN
    UPDATE users SET is_active = false WHERE id = NEW.user_id AND is_active;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_home_deactivates_user AFTER UPDATE OF is_active ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_home_deactivates_user();

-- Companies whose own facilities a user may see, with the role used there:
-- active memberships, plus (for admin or facilities_manager memberships) every descendant location
-- of that same company tree. Trees are same-type, so a provider tree only ever contains that
-- provider's own branches; customer facilities still need an active assignment (tenantScope).
-- A deactivated account (users.is_active=false) sees nothing.
CREATE OR REPLACE FUNCTION user_authorized_orgs(p_user UUID)
RETURNS TABLE (organization_id UUID, role TEXT, via_organization_id UUID, access TEXT)
LANGUAGE sql STABLE AS $$
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

-- Whole-tree exports: only an active admin of the tree's top company (or OI staff).
CREATE OR REPLACE FUNCTION can_export_tree(p_user UUID, p_org UUID) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT is_platform_staff(p_user) OR EXISTS (SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id AND u.is_active
    WHERE m.user_id = p_user AND m.organization_id = p_org AND m.is_active AND m.role = 'admin')
$$;

-- OI staff = active platform_staff row + active account + active membership in the internal org.
CREATE OR REPLACE FUNCTION is_platform_staff(p_user UUID) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM platform_staff s JOIN users u ON u.id = s.user_id AND u.is_active
    JOIN organization_memberships m ON m.user_id = s.user_id AND m.is_active
    JOIN organizations o ON o.id = m.organization_id AND o.org_type = 'internal'
    WHERE s.user_id = p_user AND s.revoked_at IS NULL)
$$;
CREATE OR REPLACE FUNCTION platform_staff_internal_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
                 WHERE m.user_id = NEW.user_id AND m.is_active AND o.org_type = 'internal') THEN
    RAISE EXCEPTION 'platform_staff_must_be_internal';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.granted_at <> OLD.granted_at
      OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id OR OLD.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'platform_staff_grant_is_immutable';
  END IF;
  RETURN NEW;
END $$;

-- user_history: target must be a member of the org; changer is an admin of that org (or of a parent), or OI staff.
CREATE OR REPLACE FUNCTION user_history_actor_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization_memberships WHERE user_id = NEW.user_id AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'user_history_wrong_org';
  END IF;
  IF NEW.changed_by_user_id = NEW.user_id THEN RAISE EXCEPTION 'user_history_no_self_change'; END IF;
  IF NOT is_platform_staff(NEW.changed_by_user_id) AND NOT EXISTS (SELECT 1 FROM user_authorized_orgs(NEW.changed_by_user_id) a
       WHERE a.organization_id = NEW.organization_id AND a.role = 'admin') THEN
    RAISE EXCEPTION 'user_history_actor_not_allowed';
  END IF;
  RETURN NEW;
END $$;

-- Provider requests: requester is an admin of the facility's company (directly or via a parent admin).
CREATE OR REPLACE FUNCTION provider_assignment_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'provider_assignment_requests_no_delete'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM properties p JOIN portfolios f ON f.id = p.portfolio_id
                   JOIN user_authorized_orgs(NEW.requested_by_user_id) a ON a.organization_id = f.organization_id AND a.role = 'admin'
                   WHERE p.id = NEW.property_id) THEN
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

-- (B) OI staff views: by facility and by service-provider company. Server-only.
CREATE OR REPLACE VIEW platform_facility_overview AS
SELECT p.id AS property_id, p.name AS property_name, p.state, f.organization_id AS owner_organization_id,
  ow.name AS owner_name,
  (WITH RECURSIVE up(id, parent, d) AS (SELECT ow.id, ow.parent_organization_id, 0 UNION ALL
     SELECT o.id, o.parent_organization_id, up.d + 1 FROM organizations o JOIN up ON o.id = up.parent WHERE up.d < 20)
   SELECT id FROM up WHERE parent IS NULL LIMIT 1) AS top_organization_id,
  COALESCE((SELECT array_agg(a.provider_organization_id ORDER BY a.provider_organization_id) FROM facility_provider_assignments a
            WHERE a.property_id = p.id AND a.revoked_at IS NULL), '{}') AS active_provider_ids,
  (SELECT count(*) FROM buildings b WHERE b.property_id = p.id) AS building_count,
  (SELECT count(*) FROM openings op JOIN buildings b ON b.id = op.building_id WHERE b.property_id = p.id) AS opening_count
FROM properties p JOIN portfolios f ON f.id = p.portfolio_id JOIN organizations ow ON ow.id = f.organization_id;

CREATE OR REPLACE VIEW platform_provider_overview AS
SELECT o.id AS provider_organization_id, o.name AS provider_name,
  count(a.property_id) FILTER (WHERE a.revoked_at IS NULL) AS active_facility_count,
  COALESCE(array_agg(a.property_id ORDER BY a.property_id) FILTER (WHERE a.revoked_at IS NULL), '{}') AS active_property_ids
FROM organizations o LEFT JOIN facility_provider_assignments a ON a.provider_organization_id = o.id
WHERE o.org_type = 'service_partner' GROUP BY o.id, o.name;

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
REVOKE EXECUTE ON FUNCTION user_authorized_orgs(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION can_export_tree(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION is_platform_staff(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON organization_memberships, platform_facility_overview, platform_provider_overview FROM anon;
    REVOKE EXECUTE ON FUNCTION user_authorized_orgs(UUID), is_platform_staff(UUID), can_export_tree(UUID, UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON organization_memberships, platform_facility_overview, platform_provider_overview FROM authenticated;
    REVOKE EXECUTE ON FUNCTION user_authorized_orgs(UUID), is_platform_staff(UUID), can_export_tree(UUID, UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT ON organization_memberships TO oi_pr2_api;
    GRANT UPDATE (role, is_active, deactivated_at, deactivated_by_user_id, deactivation_reason) ON organization_memberships TO oi_pr2_api;
    GRANT SELECT ON platform_facility_overview, platform_provider_overview TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION user_authorized_orgs(UUID), is_platform_staff(UUID), can_export_tree(UUID, UUID) TO oi_pr2_api;
  END IF;
END $$;
