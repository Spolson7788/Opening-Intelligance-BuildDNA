-- Undo for 20261029090000_member_onboarding.sql. Deploy the previous build FIRST
-- (the new API reads these columns). Refuses while invites exist or any user
-- relies on the new columns; export/decide first.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM team_invites) THEN RAISE EXCEPTION 'team_invites rows exist: refusing to drop'; END IF;
 IF EXISTS (SELECT 1 FROM users WHERE must_change_password OR is_test_account OR default_property_id IS NOT NULL OR created_by_user_id IS NOT NULL) THEN
  RAISE EXCEPTION 'users rely on onboarding columns: refusing to drop'; END IF;
END $$;
DROP TABLE team_invite_sends;
DROP TABLE team_invites;
ALTER TABLE users DROP COLUMN password_changed_at;
ALTER TABLE users DROP COLUMN created_by_user_id;
ALTER TABLE users DROP COLUMN default_property_id;
ALTER TABLE users DROP COLUMN is_test_account;
ALTER TABLE users DROP COLUMN must_change_password;
DELETE FROM schema_migrations WHERE filename='20261029090000_member_onboarding.sql';