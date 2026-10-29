-- Rollback for 20261030090600 (roll the code back first is NOT required: the API falls back to
-- 409 staff_previously_revoked when platform_staff_regrant is absent).
-- Refuses if any re-grant already happened, because dropping the history would lose the frozen
-- revoked rows. In that case keep the migration, or export the history first with its own approval.
DO $$ BEGIN
  IF to_regclass('platform_staff_grant_history') IS NOT NULL AND EXISTS (SELECT 1 FROM platform_staff_grant_history) THEN
    RAISE EXCEPTION 'platform_staff_grant_history_not_empty_refusing_rollback';
  END IF;
END $$;
DROP FUNCTION IF EXISTS platform_staff_regrant(UUID, UUID, TEXT);
DROP TABLE IF EXISTS platform_staff_grant_history;
DROP FUNCTION IF EXISTS platform_staff_grant_history_append_only();
