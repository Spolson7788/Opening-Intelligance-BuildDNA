-- Restores the pre-hardening defaults (RLS still blocks all rows). Not recommended.
GRANT EXECUTE ON FUNCTION is_platform_staff(UUID) TO PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  GRANT ALL ON platform_staff, platform_audit_events, user_history, provider_assignment_requests TO anon;
  GRANT ALL ON SEQUENCE platform_audit_events_id_seq, user_history_id_seq TO anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  GRANT ALL ON platform_staff, platform_audit_events, user_history, provider_assignment_requests TO authenticated;
  GRANT ALL ON SEQUENCE platform_audit_events_id_seq, user_history_id_seq TO authenticated;
 END IF;
END $$;
