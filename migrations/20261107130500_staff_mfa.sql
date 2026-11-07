-- SEC-2 staff authenticator (TOTP) for OI platform staff.
-- DRAFT: file only. Do not apply this from the app, and do not run npm run migrate
-- against oi-production. Customers are not given an MFA requirement.
-- Does not change platform_staff_regrant (migration 20261030090600).

CREATE TABLE IF NOT EXISTS staff_mfa_factors (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_tag BYTEA NOT NULL,
  confirmed_at TIMESTAMPTZ,
  last_accepted_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS staff_mfa_recovery_codes_user ON staff_mfa_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS staff_mfa_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded BOOLEAN NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('totp', 'recovery'))
);
CREATE INDEX IF NOT EXISTS staff_mfa_attempts_user_time ON staff_mfa_attempts (user_id, attempted_at DESC);

ALTER TABLE staff_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_mfa_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE staff_mfa_factors FROM PUBLIC;
REVOKE ALL ON TABLE staff_mfa_recovery_codes FROM PUBLIC;
REVOKE ALL ON TABLE staff_mfa_attempts FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE staff_mfa_factors FROM anon;
    REVOKE ALL ON TABLE staff_mfa_recovery_codes FROM anon;
    REVOKE ALL ON TABLE staff_mfa_attempts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE staff_mfa_factors FROM authenticated;
    REVOKE ALL ON TABLE staff_mfa_recovery_codes FROM authenticated;
    REVOKE ALL ON TABLE staff_mfa_attempts FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON staff_mfa_factors TO oi_pr2_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON staff_mfa_recovery_codes TO oi_pr2_api;
    GRANT SELECT, INSERT ON staff_mfa_attempts TO oi_pr2_api;
    GRANT USAGE, SELECT ON SEQUENCE staff_mfa_attempts_id_seq TO oi_pr2_api;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_factors' AND policyname = 'staff_mfa_factors_api') THEN
      CREATE POLICY staff_mfa_factors_api ON staff_mfa_factors FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_recovery_codes' AND policyname = 'staff_mfa_recovery_api') THEN
      CREATE POLICY staff_mfa_recovery_api ON staff_mfa_recovery_codes FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_attempts' AND policyname = 'staff_mfa_attempts_api_select') THEN
      CREATE POLICY staff_mfa_attempts_api_select ON staff_mfa_attempts FOR SELECT TO oi_pr2_api USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_mfa_attempts' AND policyname = 'staff_mfa_attempts_api_insert') THEN
      CREATE POLICY staff_mfa_attempts_api_insert ON staff_mfa_attempts FOR INSERT TO oi_pr2_api WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- Keep every action already allowed, and add the peer-reset audit action.
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
    'staff_mfa_reset'));
