-- C3 hardening: server-only access to C3 tables and is_platform_staff() (mirrors 20260926175036).
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON platform_staff, platform_audit_events, user_history, provider_assignment_requests FROM anon;
  REVOKE ALL ON SEQUENCE platform_audit_events_id_seq, user_history_id_seq FROM anon;
  REVOKE EXECUTE ON FUNCTION is_platform_staff(UUID) FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON platform_staff, platform_audit_events, user_history, provider_assignment_requests FROM authenticated;
  REVOKE ALL ON SEQUENCE platform_audit_events_id_seq, user_history_id_seq FROM authenticated;
  REVOKE EXECUTE ON FUNCTION is_platform_staff(UUID) FROM authenticated;
 END IF;
END $$;
REVOKE EXECUTE ON FUNCTION is_platform_staff(UUID) FROM PUBLIC;
