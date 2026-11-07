-- Roll back the emailed staff sign-in codes. Do not apply unless Stephan approves it.
-- Does not drop the earlier staff_mfa tables from 20261107130500.
-- If any email attempt rows exist, the attempt-kind check is left wide enough to keep them.

DROP TABLE IF EXISTS staff_sign_in_codes;

DO $$
DECLARE kind_check text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staff_mfa_attempts WHERE kind = 'email') THEN
    SELECT conname INTO kind_check FROM pg_constraint
     WHERE conrelid = 'staff_mfa_attempts'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%email%';
    IF kind_check IS NOT NULL THEN
      EXECUTE format('ALTER TABLE staff_mfa_attempts DROP CONSTRAINT %I', kind_check);
      ALTER TABLE staff_mfa_attempts ADD CONSTRAINT staff_mfa_attempts_kind_check
        CHECK (kind IN ('totp', 'recovery', 'lockout_cleared'));
    END IF;
  END IF;
END $$;
