-- Rolls back docs/ops/staging-merge-open-visits-20261112.sql.
-- Puts 610A and 710A back on their own visits and reopens those shells.
-- Do not run if a report was sent for visit 191f5a79 after the merge.

BEGIN;
UPDATE inspection_events
SET visit_id = 'b5a2e950-48e6-4801-8e40-5177d2ac0c38'
WHERE id = '8d76a607-fa06-400b-9226-367e3b14a038'
  AND visit_id = '191f5a79-1534-49fb-b486-c4bff94195b7';

UPDATE inspection_events
SET visit_id = '26c7b67d-28bc-4b44-8654-80fb9833f32a'
WHERE id = '5bee528f-8a88-44ce-a4a6-6dc7cfa8dc78'
  AND visit_id = '191f5a79-1534-49fb-b486-c4bff94195b7';

UPDATE inspection_visits
SET status = 'open', finished_at = NULL
WHERE id IN ('b5a2e950-48e6-4801-8e40-5177d2ac0c38', '26c7b67d-28bc-4b44-8654-80fb9833f32a');
COMMIT;
