-- M5 follow-up (DRAFT, not applied): allow a previously revoked OI staff member to be re-granted.
-- platform_staff rows stay immutable once revoked. A re-grant first copies the frozen revoked row,
-- unchanged, into the append-only platform_staff_grant_history table, then replaces it with a new
-- active grant, all inside one SECURITY DEFINER function that re-checks the actor is OI staff.
-- The API role gets EXECUTE only (no DELETE on platform_staff, no write on the history).
CREATE TABLE IF NOT EXISTS platform_staff_grant_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL,
  grant_reason TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL,
  revoked_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revoke_reason TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  regrant_reason TEXT NOT NULL CHECK (length(trim(regrant_reason)) > 0)
);
CREATE INDEX IF NOT EXISTS platform_staff_grant_history_user ON platform_staff_grant_history (user_id, archived_at);

CREATE OR REPLACE FUNCTION platform_staff_grant_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'platform_staff_grant_history_is_append_only'; END $$;
CREATE TRIGGER platform_staff_grant_history_append_only BEFORE UPDATE OR DELETE ON platform_staff_grant_history
  FOR EACH ROW EXECUTE FUNCTION platform_staff_grant_history_append_only();

CREATE OR REPLACE FUNCTION platform_staff_regrant(p_user UUID, p_actor UUID, p_reason TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r platform_staff%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'platform_staff_regrant_requires_reason'; END IF;
  IF p_actor IS NULL OR NOT is_platform_staff(p_actor) THEN RAISE EXCEPTION 'platform_staff_regrant_requires_oi_staff'; END IF;
  IF p_actor = p_user THEN RAISE EXCEPTION 'cannot_change_own_staff_access'; END IF;
  SELECT * INTO r FROM platform_staff WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND OR r.revoked_at IS NULL THEN RAISE EXCEPTION 'platform_staff_not_revoked'; END IF;
  INSERT INTO platform_staff_grant_history (user_id, granted_by_user_id, granted_at, grant_reason, revoked_at, revoked_by_user_id, revoke_reason, archived_by_user_id, regrant_reason)
    VALUES (r.user_id, r.granted_by_user_id, r.granted_at, r.grant_reason, r.revoked_at, r.revoked_by_user_id, r.revoke_reason, p_actor, p_reason);
  DELETE FROM platform_staff WHERE user_id = p_user;
  -- The existing insert trigger still enforces internal-org membership.
  INSERT INTO platform_staff (user_id, granted_by_user_id, grant_reason) VALUES (p_user, p_actor, p_reason);
END $$;
REVOKE ALL ON FUNCTION platform_staff_regrant(UUID, UUID, TEXT) FROM PUBLIC;

ALTER TABLE platform_staff_grant_history ENABLE ROW LEVEL SECURITY; -- no policies
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT ON platform_staff_grant_history TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION platform_staff_regrant(UUID, UUID, TEXT) TO oi_pr2_api;
  END IF;
END $$;
