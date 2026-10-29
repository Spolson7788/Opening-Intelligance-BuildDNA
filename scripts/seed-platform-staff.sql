-- NOT RUN. Founding OI staff: Stephan Olson, Michelle Aure, Andrew Aure.
-- Needs Stephan's separate approval AND confirmation of each person's exact users.id (or email),
-- and that each user belongs to the single internal OI organization. Replace the placeholders.
BEGIN;
INSERT INTO platform_staff (user_id, granted_by_user_id, grant_reason) VALUES
  ('<STEPHAN_OLSON_USER_ID>'::uuid, NULL, 'founding OI staff (approved by Stephan Olson)'),
  ('<MICHELLE_AURE_USER_ID>'::uuid, NULL, 'founding OI staff (approved by Stephan Olson)'),
  ('<ANDREW_AURE_USER_ID>'::uuid,   NULL, 'founding OI staff (approved by Stephan Olson)');
SELECT user_id, is_platform_staff(user_id) FROM platform_staff;  -- expect 3 rows, all true
COMMIT;
