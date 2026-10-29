-- Roll back 20261030090200 first (its trigger calls is_platform_staff). Roll the code back first.
DROP FUNCTION IF EXISTS is_platform_staff(UUID);
DROP TABLE IF EXISTS platform_staff;
DROP FUNCTION IF EXISTS platform_staff_internal_only();
DROP INDEX IF EXISTS organizations_single_internal_org;
