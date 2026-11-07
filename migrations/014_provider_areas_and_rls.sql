-- Provider coverage and facility access.
--
-- A provider company is a national organization (organizations.org_type =
-- 'service_partner'). Coverage lives on branches: each branch is assigned a
-- set of states and/or counties. A row with county_fips NULL covers the
-- whole state. A technician may have their own set; when they do, that set
-- is what they work in, otherwise they use their branch's set.
--
-- A facility (properties) may be assigned to a provider only when that
-- provider's branch coverage includes the facility. The database rejects
-- anything else, including for the table owner.
--
-- Row Level Security binds database roles that do not own these tables
-- (the Supabase authenticated/anon roles). The Express API connects as the
-- table owner, which bypasses RLS, and calls the same oi_private functions
-- so the rule is not only a policy. RLS is not FORCEd, so this migration
-- does not lock the existing application role out of its own tables.
--
-- oi_private is not exposed through the Data API. The helper functions
-- live there so they are not callable as public RPCs.

ALTER TABLE users
    ADD COLUMN provider_branch_id UUID;

CREATE TABLE provider_branches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

ALTER TABLE users
    ADD CONSTRAINT users_provider_branch_fk
    FOREIGN KEY (provider_branch_id) REFERENCES provider_branches(id);

CREATE TABLE provider_branch_areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID NOT NULL REFERENCES provider_branches(id) ON DELETE CASCADE,
    state_code TEXT NOT NULL REFERENCES us_states(code),
    county_fips TEXT REFERENCES us_counties(fips),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One whole-state row per branch, and one row per county. A whole-state
-- row (county_fips NULL) may sit beside county rows; coverage treats the
-- whole-state row as already including every county in that state.
CREATE UNIQUE INDEX provider_branch_areas_whole_state
    ON provider_branch_areas (branch_id, state_code)
    WHERE county_fips IS NULL;

CREATE UNIQUE INDEX provider_branch_areas_county
    ON provider_branch_areas (branch_id, county_fips)
    WHERE county_fips IS NOT NULL;

CREATE TABLE technician_areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state_code TEXT NOT NULL REFERENCES us_states(code),
    county_fips TEXT REFERENCES us_counties(fips),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX technician_areas_whole_state
    ON technician_areas (user_id, state_code)
    WHERE county_fips IS NULL;

CREATE UNIQUE INDEX technician_areas_county
    ON technician_areas (user_id, county_fips)
    WHERE county_fips IS NOT NULL;

-- Assigning a provider company to a facility. provider_branch_id NULL means
-- "any branch of this company that covers the facility." A non-null branch
-- must itself cover the facility.
CREATE TABLE facility_provider_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    provider_organization_id UUID NOT NULL REFERENCES organizations(id),
    provider_branch_id UUID REFERENCES provider_branches(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (property_id, provider_organization_id)
);

CREATE INDEX idx_provider_branches_org ON provider_branches (organization_id);
CREATE INDEX idx_provider_branch_areas_branch ON provider_branch_areas (branch_id);
CREATE INDEX idx_technician_areas_user ON technician_areas (user_id);
CREATE INDEX idx_facility_assignments_property ON facility_provider_assignments (property_id);
CREATE INDEX idx_facility_assignments_provider ON facility_provider_assignments (provider_organization_id);
CREATE INDEX idx_users_provider_branch ON users (provider_branch_id);

-- ----------------------------------------------------------------
-- Coverage helpers
-- ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION oi_private.branch_areas_cover(
    p_provider_org uuid,
    p_branch_id uuid,
    p_state text,
    p_county text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.provider_branches b
    JOIN public.provider_branch_areas a ON a.branch_id = b.id
    WHERE b.organization_id = p_provider_org
      AND (p_branch_id IS NULL OR b.id = p_branch_id)
      AND p_state IS NOT NULL
      AND a.state_code = p_state
      AND (
        a.county_fips IS NULL
        OR (p_county IS NOT NULL AND a.county_fips = p_county)
      )
  );
$$;

-- Technician's own rows win when any exist. Otherwise the branch set is used.
-- No rows and no branch means the technician covers nothing.
CREATE OR REPLACE FUNCTION oi_private.technician_area_covers(
    p_user_id uuid,
    p_branch_id uuid,
    p_state text,
    p_county text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.technician_areas t WHERE t.user_id = p_user_id)
    THEN EXISTS (
      SELECT 1 FROM public.technician_areas t
      WHERE t.user_id = p_user_id
        AND p_state IS NOT NULL
        AND t.state_code = p_state
        AND (
          t.county_fips IS NULL
          OR (p_county IS NOT NULL AND t.county_fips = p_county)
        )
    )
    ELSE EXISTS (
      SELECT 1 FROM public.provider_branch_areas a
      WHERE a.branch_id = p_branch_id
        AND p_state IS NOT NULL
        AND a.state_code = p_state
        AND (
          a.county_fips IS NULL
          OR (p_county IS NOT NULL AND a.county_fips = p_county)
        )
    )
  END;
$$;

-- Identity for RLS. Reads the same JWT claims PostgREST / Supabase set,
-- and app.current_user_id when a session sets it explicitly.
CREATE OR REPLACE FUNCTION oi_private.current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  raw text;
BEGIN
  raw := nullif(current_setting('request.jwt.claim.sub', true), '');
  IF raw IS NULL THEN
    BEGIN
      raw := nullif(current_setting('request.jwt.claims', true), '');
      IF raw IS NOT NULL THEN
        raw := nullif(raw::jsonb ->> 'sub', '');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      raw := NULL;
    END;
  END IF;
  IF raw IS NULL THEN
    raw := nullif(current_setting('app.current_user_id', true), '');
  END IF;
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION oi_private.user_org(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id FROM public.users WHERE id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION oi_private.is_manager(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id
      AND role IN ('admin', 'facilities_manager')
      AND is_active
  );
$$;

-- Owning-organization staff can see their own facilities. Provider
-- technicians are the exception: even inside their own company, and for
-- customer facilities assigned to that company, they only see a facility
-- their area covers. Customer-organization technicians are unchanged.
CREATE OR REPLACE FUNCTION oi_private.can_read_property(p_user_id uuid, p_property_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_role text;
  v_org_type text;
  v_branch uuid;
  v_owner_org uuid;
  v_state text;
  v_county text;
BEGIN
  IF p_user_id IS NULL OR p_property_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT u.organization_id, u.role, u.provider_branch_id, o.org_type
    INTO v_org, v_role, v_branch, v_org_type
  FROM public.users u
  JOIN public.organizations o ON o.id = u.organization_id
  WHERE u.id = p_user_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT pf.organization_id, p.state_code, p.county_fips
    INTO v_owner_org, v_state, v_county
  FROM public.properties p
  JOIN public.portfolios pf ON pf.id = p.portfolio_id
  WHERE p.id = p_property_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_owner_org = v_org THEN
    IF v_org_type = 'service_partner' AND v_role = 'technician' THEN
      RETURN oi_private.technician_area_covers(p_user_id, v_branch, v_state, v_county);
    END IF;
    RETURN true;
  END IF;

  IF v_org_type = 'service_partner' AND EXISTS (
    SELECT 1 FROM public.facility_provider_assignments a
    WHERE a.property_id = p_property_id
      AND a.provider_organization_id = v_org
  ) THEN
    IF v_role = 'technician' THEN
      RETURN oi_private.technician_area_covers(p_user_id, v_branch, v_state, v_county);
    END IF;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION oi_private.can_work_opening(p_user_id uuid, p_opening_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT oi_private.can_read_property(
    p_user_id,
    (
      SELECT b.property_id
      FROM public.openings o
      JOIN public.buildings b ON b.id = o.building_id
      WHERE o.id = p_opening_id
    )
  );
$$;

CREATE OR REPLACE FUNCTION oi_private.can_manage_provider_org(p_user_id uuid, p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT oi_private.is_manager(p_user_id)
    AND oi_private.user_org(p_user_id) = p_org
    AND EXISTS (
      SELECT 1 FROM public.organizations
      WHERE id = p_org AND org_type = 'service_partner'
    );
$$;

CREATE OR REPLACE FUNCTION oi_private.can_manage_assignment(
    p_user_id uuid,
    p_property_id uuid,
    p_provider_org uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT oi_private.is_manager(p_user_id)
    AND (
      EXISTS (
        SELECT 1
        FROM public.properties p
        JOIN public.portfolios pf ON pf.id = p.portfolio_id
        JOIN public.users u ON u.organization_id = pf.organization_id
        WHERE p.id = p_property_id AND u.id = p_user_id
      )
      OR oi_private.can_manage_provider_org(p_user_id, p_provider_org)
    );
$$;

CREATE OR REPLACE FUNCTION oi_private.can_manage_technician(p_actor uuid, p_technician uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT oi_private.is_manager(p_actor)
    AND EXISTS (
      SELECT 1
      FROM public.users actor
      JOIN public.users tech ON tech.organization_id = actor.organization_id
      JOIN public.organizations o ON o.id = actor.organization_id
      WHERE actor.id = p_actor
        AND tech.id = p_technician
        AND tech.role = 'technician'
        AND o.org_type = 'service_partner'
    );
$$;

-- ----------------------------------------------------------------
-- Triggers that reject illegal coverage, for every role including owner
-- ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION oi_private.enforce_area_pair()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.county_fips IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.us_counties c
    WHERE c.fips = NEW.county_fips AND c.state_code = NEW.state_code
  ) THEN
    RAISE EXCEPTION 'county_not_in_state' USING ERRCODE = '23514';
  END IF;

  -- Nested so a branch-area row, which has no user_id, never evaluates it.
  IF TG_TABLE_NAME = 'technician_areas' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.users u
      JOIN public.organizations o ON o.id = u.organization_id
      WHERE u.id = NEW.user_id
        AND u.role = 'technician'
        AND o.org_type = 'service_partner'
    ) THEN
      RAISE EXCEPTION 'technician_area_user_required' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_branch_area_pair
  BEFORE INSERT OR UPDATE ON provider_branch_areas
  FOR EACH ROW
  EXECUTE FUNCTION oi_private.enforce_area_pair();

CREATE TRIGGER enforce_technician_area_pair
  BEFORE INSERT OR UPDATE ON technician_areas
  FOR EACH ROW
  EXECUTE FUNCTION oi_private.enforce_area_pair();

CREATE OR REPLACE FUNCTION oi_private.guard_provider_branch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = NEW.organization_id AND org_type = 'service_partner'
  ) THEN
    RAISE EXCEPTION 'provider_org_required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_provider_branch
  BEFORE INSERT OR UPDATE ON provider_branches
  FOR EACH ROW
  EXECUTE FUNCTION oi_private.guard_provider_branch();

CREATE OR REPLACE FUNCTION oi_private.guard_user_branch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_org uuid;
  v_org_type text;
BEGIN
  IF NEW.provider_branch_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT b.organization_id, o.org_type
    INTO v_branch_org, v_org_type
  FROM public.provider_branches b
  JOIN public.organizations o ON o.id = b.organization_id
  WHERE b.id = NEW.provider_branch_id;

  IF v_branch_org IS NULL OR v_branch_org <> NEW.organization_id OR v_org_type <> 'service_partner' THEN
    RAISE EXCEPTION 'user_branch_org_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_user_branch
  BEFORE INSERT OR UPDATE OF provider_branch_id, organization_id ON users
  FOR EACH ROW
  EXECUTE FUNCTION oi_private.guard_user_branch();

CREATE OR REPLACE FUNCTION oi_private.guard_facility_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text;
  v_county text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = NEW.provider_organization_id AND org_type = 'service_partner'
  ) THEN
    RAISE EXCEPTION 'provider_org_required' USING ERRCODE = '23514';
  END IF;

  IF NEW.provider_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.provider_branches b
    WHERE b.id = NEW.provider_branch_id
      AND b.organization_id = NEW.provider_organization_id
  ) THEN
    RAISE EXCEPTION 'branch_not_in_provider' USING ERRCODE = '23514';
  END IF;

  SELECT state_code, county_fips INTO v_state, v_county
  FROM public.properties WHERE id = NEW.property_id;

  IF NOT oi_private.branch_areas_cover(
    NEW.provider_organization_id, NEW.provider_branch_id, v_state, v_county
  ) THEN
    RAISE EXCEPTION 'out_of_area' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_facility_assignment
  BEFORE INSERT OR UPDATE ON facility_provider_assignments
  FOR EACH ROW
  EXECUTE FUNCTION oi_private.guard_facility_assignment();

-- Replaces the location trigger function from 013, adding the rule that a
-- facility cannot be moved out from under a provider assignment.
CREATE OR REPLACE FUNCTION oi_private.prepare_property_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.state_code IS NULL AND NEW.state IS NOT NULL THEN
    SELECT s.code INTO NEW.state_code
    FROM public.us_states s
    WHERE upper(btrim(NEW.state)) = s.code
       OR lower(btrim(NEW.state)) = lower(s.name)
    LIMIT 1;
  END IF;

  IF NEW.county_fips IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.us_counties c
    WHERE c.fips = NEW.county_fips
      AND c.state_code = NEW.state_code
  ) THEN
    RAISE EXCEPTION 'county_not_in_state' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.state_code IS DISTINCT FROM OLD.state_code
    OR NEW.county_fips IS DISTINCT FROM OLD.county_fips
  ) AND EXISTS (
    SELECT 1
    FROM public.facility_provider_assignments a
    WHERE a.property_id = NEW.id
      AND NOT oi_private.branch_areas_cover(
        a.provider_organization_id, a.provider_branch_id, NEW.state_code, NEW.county_fips
      )
  ) THEN
    RAISE EXCEPTION 'assignment_would_be_out_of_area' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Dropping or shrinking a branch's area must not leave an assignment that
-- no longer covers its facility.
CREATE OR REPLACE FUNCTION oi_private.guard_branch_area_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch uuid := COALESCE(OLD.branch_id, NEW.branch_id);
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org
  FROM public.provider_branches WHERE id = v_branch;

  IF EXISTS (
    SELECT 1
    FROM public.facility_provider_assignments a
    JOIN public.properties p ON p.id = a.property_id
    WHERE a.provider_organization_id = v_org
      AND (a.provider_branch_id IS NULL OR a.provider_branch_id = v_branch)
      AND NOT oi_private.branch_areas_cover(
        a.provider_organization_id, a.provider_branch_id, p.state_code, p.county_fips
      )
  ) THEN
    RAISE EXCEPTION 'area_change_would_uncover_assignment' USING ERRCODE = '23514';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER guard_branch_area_change
  AFTER UPDATE OR DELETE ON provider_branch_areas
  FOR EACH ROW
  EXECUTE FUNCTION oi_private.guard_branch_area_change();

-- ----------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------

GRANT USAGE ON SCHEMA oi_private TO PUBLIC;

ALTER TABLE us_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE us_counties ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_branch_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_provider_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY us_states_read ON us_states
  FOR SELECT USING (true);

CREATE POLICY us_counties_read ON us_counties
  FOR SELECT USING (true);

CREATE POLICY properties_select ON properties
  FOR SELECT USING (oi_private.can_read_property(oi_private.current_user_id(), id));

CREATE POLICY buildings_select ON buildings
  FOR SELECT USING (oi_private.can_read_property(oi_private.current_user_id(), property_id));

CREATE POLICY openings_select ON openings
  FOR SELECT USING (oi_private.can_work_opening(oi_private.current_user_id(), id));

CREATE POLICY service_events_select ON service_events
  FOR SELECT USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY service_events_insert ON service_events
  FOR INSERT WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY inspection_events_select ON inspection_events
  FOR SELECT USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY inspection_events_insert ON inspection_events
  FOR INSERT WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY hardware_select ON hardware_components
  FOR SELECT USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY hardware_insert ON hardware_components
  FOR INSERT WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY hardware_update ON hardware_components
  FOR UPDATE
  USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id))
  WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY photos_select ON photos
  FOR SELECT USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY photos_insert ON photos
  FOR INSERT WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY photos_delete ON photos
  FOR DELETE USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY work_orders_select ON work_orders
  FOR SELECT USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY work_orders_update ON work_orders
  FOR UPDATE
  USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id))
  WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY provider_branches_select ON provider_branches
  FOR SELECT USING (organization_id = oi_private.user_org(oi_private.current_user_id()));

CREATE POLICY provider_branches_insert ON provider_branches
  FOR INSERT WITH CHECK (oi_private.can_manage_provider_org(oi_private.current_user_id(), organization_id));

CREATE POLICY provider_branches_update ON provider_branches
  FOR UPDATE
  USING (oi_private.can_manage_provider_org(oi_private.current_user_id(), organization_id))
  WITH CHECK (oi_private.can_manage_provider_org(oi_private.current_user_id(), organization_id));

CREATE POLICY provider_branch_areas_select ON provider_branch_areas
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.provider_branches b
      WHERE b.id = branch_id
        AND b.organization_id = oi_private.user_org(oi_private.current_user_id())
    )
  );

CREATE POLICY provider_branch_areas_write ON provider_branch_areas
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.provider_branches b
      WHERE b.id = branch_id
        AND oi_private.can_manage_provider_org(oi_private.current_user_id(), b.organization_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.provider_branches b
      WHERE b.id = branch_id
        AND oi_private.can_manage_provider_org(oi_private.current_user_id(), b.organization_id)
    )
  );

CREATE POLICY technician_areas_select ON technician_areas
  FOR SELECT USING (
    user_id = oi_private.current_user_id()
    OR EXISTS (
      SELECT 1 FROM public.users tech
      WHERE tech.id = technician_areas.user_id
        AND oi_private.can_manage_provider_org(oi_private.current_user_id(), tech.organization_id)
    )
  );

CREATE POLICY technician_areas_write ON technician_areas
  FOR ALL
  USING (oi_private.can_manage_technician(oi_private.current_user_id(), user_id))
  WITH CHECK (oi_private.can_manage_technician(oi_private.current_user_id(), user_id));

CREATE POLICY facility_assignments_select ON facility_provider_assignments
  FOR SELECT USING (oi_private.can_read_property(oi_private.current_user_id(), property_id));

CREATE POLICY facility_assignments_insert ON facility_provider_assignments
  FOR INSERT WITH CHECK (
    oi_private.can_manage_assignment(oi_private.current_user_id(), property_id, provider_organization_id)
  );

CREATE POLICY facility_assignments_delete ON facility_provider_assignments
  FOR DELETE USING (
    oi_private.can_manage_assignment(oi_private.current_user_id(), property_id, provider_organization_id)
  );

-- Supabase's authenticated role already exists on hosted projects. Grant
-- the table privileges RLS then narrows. Skip when the role is absent
-- (local Postgres used by the Express tests).
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA oi_private TO authenticated;
    FOREACH t IN ARRAY ARRAY[
      'us_states', 'us_counties', 'properties', 'buildings', 'openings',
      'service_events', 'inspection_events', 'hardware_components', 'photos',
      'work_orders', 'provider_branches', 'provider_branch_areas',
      'technician_areas', 'facility_provider_assignments'
    ]
    LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated',
        t
      );
    END LOOP;
  END IF;
END $$;
