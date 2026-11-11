-- PROPOSED ONLY. Do not apply this file. It is not in migrations/, so the
-- deploy runner will not pick it up. Apply it only after Stephan approves.
--
-- Plain English:
-- Today a provider can see customer sites only through a facility grant, and
-- its own sites have no account kind. This proposal adds that kind, one shared
-- Walk-in bucket per provider, a way to upgrade a small account into a customer
-- company, a real quote approval status, routes and stops, a stamp for when a
-- site address was geocoded, which work may be picked up, which customers need
-- notice before a drop-in, and a guard so two technicians cannot claim the same
-- work. Latitude and longitude already exist on properties and stay the coordinates.

-- One relationship between a provider and an account it manages.
CREATE TABLE provider_accounts (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('facility', 'small', 'walkin')),
  customer_organization_id UUID REFERENCES organizations(id),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  notice_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'facility' OR customer_organization_id IS NOT NULL),
  CHECK (kind <> 'walkin' OR customer_organization_id IS NULL)
);

-- One shared Walk-in bucket per provider. Facility and small accounts are not limited.
CREATE UNIQUE INDEX provider_accounts_one_walkin
  ON provider_accounts (provider_organization_id)
  WHERE kind = 'walkin';

-- Sites that belong to an account. A small-account upgrade keeps the same sites
-- and points customer_organization_id at the new customer company.
CREATE TABLE provider_account_sites (
  account_id UUID NOT NULL REFERENCES provider_accounts(id),
  property_id UUID NOT NULL REFERENCES properties(id),
  PRIMARY KEY (account_id, property_id)
);

-- Existing properties.latitude and properties.longitude remain the coordinates.
-- These two columns only record that an address was geocoded, and by which source.
ALTER TABLE properties ADD COLUMN geocoded_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN geocode_source TEXT;

-- Quotes are saved estimates today. This status is what "awaiting approval" needs.
ALTER TABLE replacement_estimates
  ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (approval_status IN ('draft', 'awaiting_approval', 'approved', 'declined'));

-- The provider marks a piece of work eligible for nearby pickup.
CREATE TABLE work_pickup_eligibility (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  work_kind TEXT NOT NULL CHECK (work_kind IN ('work_order', 'inspection', 'advised_repair')),
  work_id UUID NOT NULL,
  eligible BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (provider_organization_id, work_kind, work_id)
);

-- One technician's day. Version 1 still hands driving to Apple Maps or Google Maps.
CREATE TABLE service_routes (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  service_date DATE NOT NULL,
  assigned_user_id UUID REFERENCES users(id),
  auto_approve_small_jobs BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_route_stops (
  id UUID PRIMARY KEY,
  route_id UUID NOT NULL REFERENCES service_routes(id),
  position INTEGER NOT NULL CHECK (position > 0),
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'declined')),
  work_kind TEXT NOT NULL CHECK (work_kind IN ('work_order', 'inspection', 'advised_repair')),
  work_id UUID NOT NULL,
  property_id UUID NOT NULL REFERENCES properties(id),
  time_window TEXT,
  drive_minutes INTEGER CHECK (drive_minutes IS NULL OR drive_minutes >= 0),
  requested_by_user_id UUID REFERENCES users(id),
  UNIQUE (route_id, position)
);

-- A second request or approval for the same work is refused while one claim is open.
CREATE UNIQUE INDEX service_route_stops_one_open_claim
  ON service_route_stops (work_kind, work_id)
  WHERE status IN ('requested', 'approved');
