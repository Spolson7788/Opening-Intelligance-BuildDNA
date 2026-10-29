-- C3d (revised per Stephan, Oct 29):
--  * Deactivation by a facility or provider admin is IMMEDIATE (no OI review). The API updates users
--    directly and writes one user_history row (who, when, why, prior snapshot) so it can be reversed
--    by reactivation. No change to the users table.
--  * Provider assignment: OI staff assign providers. A facility admin files a provider_assignment_requests
--    row; OI staff approve or decline it.
CREATE TABLE IF NOT EXISTS user_history (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  changed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  change TEXT NOT NULL CHECK (change IN ('deactivate','reactivate','role_change')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  CHECK (NOT (before_state ? 'password_hash') AND NOT (after_state ? 'password_hash'))
);
CREATE INDEX IF NOT EXISTS user_history_user ON user_history (user_id, at DESC);
CREATE OR REPLACE FUNCTION user_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'user_history_append_only'; END $$;
CREATE TRIGGER user_history_append_only BEFORE UPDATE OR DELETE ON user_history
  FOR EACH ROW EXECUTE FUNCTION user_history_append_only();
CREATE TRIGGER user_history_no_truncate BEFORE TRUNCATE ON user_history
  FOR EACH STATEMENT EXECUTE FUNCTION user_history_append_only();
-- The changer is the user's own org admin, or active OI staff.
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
CREATE TRIGGER user_history_actor_check BEFORE INSERT ON user_history
  FOR EACH ROW EXECUTE FUNCTION user_history_actor_check();

CREATE TABLE IF NOT EXISTS provider_assignment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL DEFAULT 'assign' CHECK (action IN ('assign','unassign')),
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','withdrawn')),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CHECK ((status IN ('approved','declined')) = (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_assignment_requests_one_pending
  ON provider_assignment_requests (property_id, provider_organization_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS provider_assignment_requests_queue ON provider_assignment_requests (status, requested_at);

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
CREATE TRIGGER provider_assignment_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON provider_assignment_requests
  FOR EACH ROW EXECUTE FUNCTION provider_assignment_requests_guard();

ALTER TABLE user_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_assignment_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT ON user_history TO oi_pr2_api;
    GRANT USAGE ON SEQUENCE user_history_id_seq TO oi_pr2_api;
    GRANT SELECT, INSERT ON provider_assignment_requests TO oi_pr2_api;
    GRANT UPDATE (status, reviewed_by_user_id, reviewed_at, review_note) ON provider_assignment_requests TO oi_pr2_api;
  END IF;
END $$;
