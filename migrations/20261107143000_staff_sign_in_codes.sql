-- SEC-2 staff emailed sign-in codes. Additive.
-- Do not edit 20261107130500_staff_mfa.sql; that file is already applied on staging.
-- DRAFT until Stephan approves applying it. Do not run npm run migrate against oi-production.

CREATE TABLE IF NOT EXISTS staff_sign_in_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS staff_sign_in_codes_user_created ON staff_sign_in_codes (user_id, created_at DESC);

ALTER TABLE staff_sign_in_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_sign_in_codes FROM PUBLIC;

DO $$
DECLARE kind_check text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE staff_sign_in_codes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE staff_sign_in_codes FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE ON staff_sign_in_codes TO oi_pr2_api;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_sign_in_codes' AND policyname = 'staff_sign_in_codes_api') THEN
      CREATE POLICY staff_sign_in_codes_api ON staff_sign_in_codes FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
  END IF;
  SELECT conname INTO kind_check FROM pg_constraint
   WHERE conrelid = 'staff_mfa_attempts'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%lockout_cleared%';
  IF kind_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE staff_mfa_attempts DROP CONSTRAINT %I', kind_check);
    ALTER TABLE staff_mfa_attempts ADD CONSTRAINT staff_mfa_attempts_kind_check
      CHECK (kind IN ('totp', 'recovery', 'lockout_cleared', 'email'));
  END IF;
END $$;
