-- Optional. Staging only. Do not run with npm run migrate.
-- Finishes the two Nov 9 open visits. Does not move their inspections.
-- Run only with a separate decision. Those inspections stay on these visits.

BEGIN;
UPDATE inspection_visits
SET status = 'finished', finished_at = COALESCE(finished_at, now())
WHERE id IN ('d4797268-3e8f-457f-8229-79feed51ce77', 'e7e061f8-622e-4848-93a3-5cf96c5e3941')
  AND inspector_user_id = '3d45de85-76b6-4113-92b0-2dc67842e16b'
  AND property_id = 'c9d8e9e6-361d-4b95-b20b-cb06263775c9'
  AND status = 'open';
COMMIT;
