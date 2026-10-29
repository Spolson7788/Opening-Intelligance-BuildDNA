-- C3a: OI staff (platform) role. OI owns all data: the API lets active staff read all customer data
-- server-side (RLS stays on, no policies, nothing public).
-- A user is OI staff only when ALL hold: an active platform_staff row, the user is active,
-- and the user belongs to the single organization with org_type='internal'. Org roles are unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_single_internal_org
  ON organizations (org_type) WHERE org_type = 'internal';

CREATE TABLE IF NOT EXISTS platform_staff (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  granted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT, -- NULL only for founding rows inserted by the separately approved seed script
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  grant_reason TEXT NOT NULL CHECK (length(trim(grant_reason)) > 0),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  revoke_reason TEXT,
  CHECK (granted_by_user_id IS NULL OR granted_by_user_id <> user_id),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
  CHECK (revoked_by_user_id IS NULL OR revoked_by_user_id <> user_id)
);
-- Founding rows (no granter) come only from scripts/seed-platform-staff.sql, run with its own approval.

-- Staff must belong to the internal org.
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
CREATE TRIGGER platform_staff_internal_only BEFORE INSERT OR UPDATE ON platform_staff
  FOR EACH ROW EXECUTE FUNCTION platform_staff_internal_only();

-- Server-side check used by the API on every platform request.
CREATE OR REPLACE FUNCTION is_platform_staff(p_user UUID) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM platform_staff s JOIN users u ON u.id = s.user_id
    JOIN organizations o ON o.id = u.organization_id
    WHERE s.user_id = p_user AND s.revoked_at IS NULL AND u.is_active AND o.org_type = 'internal')
$$;

ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY; -- no policies: unreachable through the public data API
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT ON platform_staff TO oi_pr2_api;
    GRANT UPDATE (revoked_at, revoked_by_user_id, revoke_reason) ON platform_staff TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION is_platform_staff(UUID) TO oi_pr2_api;
  END IF;
END $$;
