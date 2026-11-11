-- Roll back company dashboard phase 2. Do not run unless Stephan approves it,
-- and never on production. Drops only the tables and columns this migration added.
-- Openings, grants, estimates, work orders, and their other columns stay.

DROP TABLE IF EXISTS service_route_stops;
DROP TABLE IF EXISTS service_routes;
DROP TABLE IF EXISTS work_pickup_eligibility;
DROP TABLE IF EXISTS provider_account_sites;
DROP TABLE IF EXISTS provider_accounts;

ALTER TABLE properties DROP COLUMN IF EXISTS geocoded_at;
ALTER TABLE properties DROP COLUMN IF EXISTS geocode_source;
ALTER TABLE replacement_estimates DROP COLUMN IF EXISTS approval_status;
