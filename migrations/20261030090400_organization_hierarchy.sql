-- Multi-location customers (DRAFT, not applied). A customer company may have a parent company.
-- Facilities keep hanging off an organization through portfolios -> properties; a location org
-- owns its own portfolios. Admins of a parent company see every descendant location (recursive).
-- Customer and provider companies may each form same-type trees (OI staff only); the OI org never.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE organizations ADD CONSTRAINT organizations_parent_not_self CHECK (parent_organization_id IS NULL OR parent_organization_id <> id);
CREATE INDEX IF NOT EXISTS organizations_parent ON organizations (parent_organization_id) WHERE parent_organization_id IS NOT NULL;

-- Parent links: only active OI staff may set or change them, and every change is audited.
-- The API sets the acting user and reason for the transaction:
--   SELECT set_config('oi.actor_user_id', <staff id>, true), set_config('oi.reason', <why>, true);
-- Linking a provider under another provider also needs set_config('oi.confirm_provider_link','confirmed',true).
-- Trees: customer under customer, provider under provider (same type only). The OI org never.
-- Provider trees never reach customer data: facility access stays assignment-only (app layer).
ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
    'org_created','first_admin_invited','facility_created',
    'staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked',
    'org_parent_changed','membership_added','membership_removed'));

CREATE OR REPLACE FUNCTION organizations_hierarchy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE depth INT; actor UUID; why TEXT; confirmed BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.org_type <> OLD.org_type AND (NEW.parent_organization_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM organizations WHERE parent_organization_id = NEW.id)) THEN
    RAISE EXCEPTION 'organization_hierarchy_type_locked';
  END IF;
  IF NEW.parent_organization_id IS NOT DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.parent_organization_id END) THEN
    RETURN NEW;
  END IF;
  actor := NULLIF(current_setting('oi.actor_user_id', true), '')::uuid;
  why := NULLIF(trim(current_setting('oi.reason', true)), '');
  IF actor IS NULL OR NOT is_platform_staff(actor) THEN RAISE EXCEPTION 'organization_parent_requires_oi_staff'; END IF;
  IF why IS NULL THEN RAISE EXCEPTION 'organization_parent_requires_reason'; END IF;
  IF NEW.parent_organization_id IS NOT NULL THEN
    IF NEW.org_type NOT IN ('customer','service_partner') OR NOT EXISTS (SELECT 1 FROM organizations
         WHERE id = NEW.parent_organization_id AND org_type = NEW.org_type) THEN
      RAISE EXCEPTION 'organization_hierarchy_same_type_only';
    END IF;
    -- Making one provider company a branch of another merges their visibility: explicit confirmation required.
    IF NEW.org_type = 'service_partner' THEN
      IF current_setting('oi.confirm_provider_link', true) IS DISTINCT FROM 'confirmed' THEN
        RAISE EXCEPTION 'organization_provider_link_requires_confirmation';
      END IF;
      confirmed := true;
    END IF;
    IF EXISTS (WITH RECURSIVE up(id, parent, d) AS (
        SELECT id, parent_organization_id, 1 FROM organizations WHERE id = NEW.parent_organization_id
        UNION ALL SELECT o.id, o.parent_organization_id, up.d + 1 FROM organizations o JOIN up ON o.id = up.parent WHERE up.d < 20)
      SELECT 1 FROM up WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'organization_hierarchy_cycle';
    END IF;
    WITH RECURSIVE up(id, parent, d) AS (
      SELECT id, parent_organization_id, 1 FROM organizations WHERE id = NEW.parent_organization_id
      UNION ALL SELECT o.id, o.parent_organization_id, up.d + 1 FROM organizations o JOIN up ON o.id = up.parent WHERE up.d < 20)
    SELECT max(d) INTO depth FROM up;
    IF depth >= 10 THEN RAISE EXCEPTION 'organization_hierarchy_too_deep'; END IF;
  END IF;
  INSERT INTO platform_audit_events (actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
  SELECT actor, u.organization_id, 'org_parent_changed', NEW.id, NEW.id, why,
    jsonb_build_object('parent_organization_id', CASE WHEN TG_OP = 'UPDATE' THEN OLD.parent_organization_id END),
    jsonb_build_object('parent_organization_id', NEW.parent_organization_id, 'org_type', NEW.org_type,
      'provider_link_confirmed', confirmed)
  FROM users u WHERE u.id = actor;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_hierarchy_guard BEFORE INSERT OR UPDATE OF parent_organization_id, org_type ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_hierarchy_guard();

-- The org itself plus every descendant location.
CREATE OR REPLACE FUNCTION organization_subtree(p_org UUID) RETURNS SETOF UUID LANGUAGE sql STABLE AS $$
  WITH RECURSIVE t(id, d) AS (SELECT p_org, 0 UNION ALL
    SELECT o.id, t.d + 1 FROM organizations o JOIN t ON o.parent_organization_id = t.id WHERE t.d < 20)
  SELECT id FROM t
$$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT (parent_organization_id), UPDATE (parent_organization_id) ON organizations TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION organization_subtree(UUID) TO oi_pr2_api;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION organization_subtree(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE EXECUTE ON FUNCTION organization_subtree(UUID) FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE EXECUTE ON FUNCTION organization_subtree(UUID) FROM authenticated; END IF;
END $$;
