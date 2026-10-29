-- C3a: append-only audit of every OI staff action and every deactivation and provider-assignment step.
CREATE TABLE IF NOT EXISTS platform_audit_events (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'org_created','first_admin_invited','facility_created',
    'staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked')),
  target_org_id UUID REFERENCES organizations(id) ON DELETE RESTRICT,
  target_id UUID,
  reason TEXT,
  before_state JSONB,
  after_state JSONB,
  request_ref UUID
);
CREATE INDEX IF NOT EXISTS platform_audit_events_target_org ON platform_audit_events (target_org_id, at DESC);

CREATE OR REPLACE FUNCTION platform_audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'platform_audit_events_append_only'; END $$;
CREATE TRIGGER platform_audit_events_append_only BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform_audit_events_append_only();
CREATE TRIGGER platform_audit_events_no_truncate BEFORE TRUNCATE ON platform_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_events_append_only();

ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT ON platform_audit_events TO oi_pr2_api;
    GRANT USAGE ON SEQUENCE platform_audit_events_id_seq TO oi_pr2_api;
  END IF;
END $$;
