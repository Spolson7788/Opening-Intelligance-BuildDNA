-- Staging only: boaoedvyvifppuklbwad. Do not run this with npm run migrate.
-- Not applied. Stephan must approve the run.
-- Moves 610A and 710A onto the 7:53 AM visit and finishes the two empty shells.
-- Inspections stay. One transaction.

BEGIN;
DO $$
DECLARE
  moved integer;
  finished integer;
BEGIN
  UPDATE inspection_events
  SET visit_id = '191f5a79-1534-49fb-b486-c4bff94195b7'
  WHERE id = '8d76a607-fa06-400b-9226-367e3b14a038'
    AND visit_id = 'b5a2e950-48e6-4801-8e40-5177d2ac0c38';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'expected to move 610A inspection 8d76a607';
  END IF;

  UPDATE inspection_events
  SET visit_id = '191f5a79-1534-49fb-b486-c4bff94195b7'
  WHERE id = '5bee528f-8a88-44ce-a4a6-6dc7cfa8dc78'
    AND visit_id = '26c7b67d-28bc-4b44-8654-80fb9833f32a';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'expected to move 710A inspection 5bee528f';
  END IF;

  UPDATE inspection_visits
  SET status = 'finished', finished_at = COALESCE(finished_at, now())
  WHERE id IN ('b5a2e950-48e6-4801-8e40-5177d2ac0c38', '26c7b67d-28bc-4b44-8654-80fb9833f32a')
    AND status = 'open';
  GET DIAGNOSTICS finished = ROW_COUNT;
  IF finished <> 2 THEN
    RAISE EXCEPTION 'expected to finish the 610A and 710A visit shells';
  END IF;
END $$;
COMMIT;
