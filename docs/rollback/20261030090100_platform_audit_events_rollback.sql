-- Roll the code back first. Destroys the audit trail: export it before running.
DROP TABLE IF EXISTS platform_audit_events;
DROP FUNCTION IF EXISTS platform_audit_events_append_only();
