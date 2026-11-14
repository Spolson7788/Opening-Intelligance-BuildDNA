-- Company dashboard phase 2. Additive and idempotent. Approved for the staging
-- database boaoedvyvifppuklbwad only. Do not apply to production bekaxmatcvxqpjixwsqn.
-- Existing openings, grants, estimates, and work orders are not deleted or rewritten.
-- A new approval_status column on replacement_estimates defaults to draft.

CREATE TABLE IF NOT EXISTS provider_accounts (
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

CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_one_walkin
  ON provider_accounts (provider_organization_id)
  WHERE kind = 'walkin';

CREATE INDEX IF NOT EXISTS provider_accounts_provider
  ON provider_accounts (provider_organization_id, kind);

CREATE TABLE IF NOT EXISTS provider_account_sites (
  account_id UUID NOT NULL REFERENCES provider_accounts(id),
  property_id UUID NOT NULL REFERENCES properties(id),
  PRIMARY KEY (account_id, property_id)
);

CREATE INDEX IF NOT EXISTS provider_account_sites_property
  ON provider_account_sites (property_id);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocode_source TEXT;

ALTER TABLE replacement_estimates
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'draft';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'replacement_estimates_approval_status_check'
  ) THEN
    ALTER TABLE replacement_estimates ADD CONSTRAINT replacement_estimates_approval_status_check
      CHECK (approval_status IN ('draft', 'awaiting_approval', 'approved', 'declined'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS work_pickup_eligibility (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  work_kind TEXT NOT NULL CHECK (work_kind IN ('work_order', 'inspection', 'advised_repair')),
  work_id UUID NOT NULL,
  eligible BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (provider_organization_id, work_kind, work_id)
);

CREATE TABLE IF NOT EXISTS service_routes (
  id UUID PRIMARY KEY,
  provider_organization_id UUID NOT NULL REFERENCES organizations(id),
  service_date DATE NOT NULL,
  assigned_user_id UUID REFERENCES users(id),
  auto_approve_small_jobs BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_route_stops (
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

CREATE UNIQUE INDEX IF NOT EXISTS service_route_stops_one_open_claim
  ON service_route_stops (work_kind, work_id)
  WHERE status IN ('requested', 'approved');

-- One Walk-in bucket per provider for every owned site whose name contains Walk-in.
INSERT INTO provider_accounts (id, provider_organization_id, kind, display_name)
SELECT gen_random_uuid(), owned.provider_id, 'walkin', 'Walk-in'
FROM (
  SELECT DISTINCT pf.organization_id AS provider_id
  FROM properties prop
  JOIN portfolios pf ON pf.id = prop.portfolio_id
  JOIN organizations org ON org.id = pf.organization_id
  WHERE org.org_type = 'service_partner'
    AND prop.name ~* '\ywalk[-\s]?in\y'
) owned
WHERE NOT EXISTS (
  SELECT 1 FROM provider_accounts existing
  WHERE existing.provider_organization_id = owned.provider_id AND existing.kind = 'walkin'
);

INSERT INTO provider_account_sites (account_id, property_id)
SELECT account.id, prop.id
FROM properties prop
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN organizations org ON org.id = pf.organization_id
JOIN provider_accounts account
  ON account.provider_organization_id = pf.organization_id AND account.kind = 'walkin'
WHERE org.org_type = 'service_partner'
  AND prop.name ~* '\ywalk[-\s]?in\y'
  AND NOT EXISTS (
    SELECT 1 FROM provider_account_sites linked
    JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
    WHERE linked.property_id = prop.id
      AND linked_account.provider_organization_id = pf.organization_id
  )
ON CONFLICT DO NOTHING;

-- Every other provider-owned site becomes its own Small account. The account id
-- is the property id, so running this again does not create a second account.
INSERT INTO provider_accounts (id, provider_organization_id, kind, display_name)
SELECT prop.id, pf.organization_id, 'small', left(trim(prop.name), 200)
FROM properties prop
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN organizations org ON org.id = pf.organization_id
WHERE org.org_type = 'service_partner'
  AND length(trim(prop.name)) > 0
  AND prop.name !~* '\ywalk[-\s]?in\y'
  AND NOT EXISTS (
    SELECT 1 FROM provider_account_sites linked
    JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
    WHERE linked.property_id = prop.id
      AND linked_account.provider_organization_id = pf.organization_id
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_account_sites (account_id, property_id)
SELECT account.id, prop.id
FROM properties prop
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN provider_accounts account ON account.id = prop.id AND account.kind = 'small'
WHERE NOT EXISTS (
  SELECT 1 FROM provider_account_sites linked
  JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
  WHERE linked.property_id = prop.id
    AND linked_account.provider_organization_id = account.provider_organization_id
)
ON CONFLICT DO NOTHING;

-- Active grants become facility accounts, one per provider and customer company.
INSERT INTO provider_accounts (id, provider_organization_id, kind, customer_organization_id, display_name)
SELECT gen_random_uuid(), grant_row.provider_organization_id, 'facility', grant_row.customer_id,
       COALESCE(NULLIF(left(trim(grant_row.customer_name), 200), ''), 'Facility account')
FROM (
  SELECT DISTINCT fpa.provider_organization_id, owner.id AS customer_id, owner.name AS customer_name
  FROM facility_provider_assignments fpa
  JOIN properties prop ON prop.id = fpa.property_id
  JOIN portfolios pf ON pf.id = prop.portfolio_id
  JOIN organizations owner ON owner.id = pf.organization_id
  WHERE fpa.revoked_at IS NULL AND owner.org_type = 'customer'
) grant_row
WHERE NOT EXISTS (
  SELECT 1 FROM provider_accounts existing
  WHERE existing.provider_organization_id = grant_row.provider_organization_id
    AND existing.kind = 'facility'
    AND existing.customer_organization_id = grant_row.customer_id
);

INSERT INTO provider_account_sites (account_id, property_id)
SELECT account.id, fpa.property_id
FROM facility_provider_assignments fpa
JOIN properties prop ON prop.id = fpa.property_id
JOIN portfolios pf ON pf.id = prop.portfolio_id
JOIN organizations owner ON owner.id = pf.organization_id
JOIN provider_accounts account
  ON account.provider_organization_id = fpa.provider_organization_id
 AND account.kind = 'facility'
 AND account.customer_organization_id = owner.id
WHERE fpa.revoked_at IS NULL
  AND owner.org_type = 'customer'
  AND NOT EXISTS (
    SELECT 1 FROM provider_account_sites linked
    JOIN provider_accounts linked_account ON linked_account.id = linked.account_id
    WHERE linked.property_id = fpa.property_id
      AND linked_account.provider_organization_id = fpa.provider_organization_id
  )
ON CONFLICT DO NOTHING;

ALTER TABLE provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_account_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_pickup_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_route_stops ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE tbl text; roles text; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles
  FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOREACH tbl IN ARRAY ARRAY['provider_accounts','provider_account_sites','work_pickup_eligibility','service_routes','service_route_stops'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', tbl);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %I FROM %s', tbl, roles); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO oi_pr2_api', tbl);
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'server_select') THEN
        EXECUTE format('CREATE POLICY server_select ON %I FOR SELECT TO oi_pr2_api USING (true)', tbl);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'server_insert') THEN
        EXECUTE format('CREATE POLICY server_insert ON %I FOR INSERT TO oi_pr2_api WITH CHECK (true)', tbl);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'server_update') THEN
        EXECUTE format('CREATE POLICY server_update ON %I FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true)', tbl);
      END IF;
    END IF;
  END LOOP;
END $$;
