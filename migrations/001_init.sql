-- Opening Intelligence Platform — Initial Schema
-- Hierarchy: Portfolio -> Property -> Building -> Opening -> HardwareComponent
--                                                          -> ServiceEvent
--                                                          -> InspectionEvent

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ORGANIZATIONS & USERS (multi-tenant from day one, even if MVP only serves 1-2 tenants)
-- ============================================================

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    org_type TEXT NOT NULL CHECK (org_type IN ('customer', 'service_partner', 'internal')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'facilities_manager', 'technician', 'inspector', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ASSET HIERARCHY
-- ============================================================

CREATE TABLE portfolios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id UUID NOT NULL REFERENCES portfolios(id),
    name TEXT NOT NULL,
    address_line1 TEXT,
    city TEXT,
    state TEXT,
    postal_code TEXT,
    property_type TEXT CHECK (property_type IN ('multifamily', 'senior_living', 'healthcare', 'university', 'hospitality', 'other')),
    latitude NUMERIC(9,6),
    longitude NUMERIC(9,6),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE buildings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id),
    name TEXT NOT NULL,          -- e.g. "Building 03"
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The core entity: a single physical opening (door, dock, gate, etc.)
CREATE TABLE openings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_code TEXT NOT NULL UNIQUE,   -- e.g. AZ-PHX-BLDG03-F02-0214 (VIN-style, human-assigned or auto-generated)
    building_id UUID NOT NULL REFERENCES buildings(id),
    floor_label TEXT,                    -- "F02", "Ground", "Basement"
    location_description TEXT,           -- "East stairwell exterior door"
    opening_type TEXT NOT NULL CHECK (opening_type IN (
        'door', 'overhead_door', 'loading_dock', 'gate', 'automatic_entrance', 'access_control_point'
    )),
    latitude NUMERIC(9,6),
    longitude NUMERIC(9,6),
    fire_rated BOOLEAN NOT NULL DEFAULT false,
    life_safety_critical BOOLEAN NOT NULL DEFAULT false,
    install_date DATE,
    last_service_date DATE,
    health_score NUMERIC(5,2),           -- 0-100, computed field, updated by trigger/job
    qr_token TEXT NOT NULL UNIQUE,       -- opaque token embedded in the printed QR (separate from opening_code so codes can be relabeled without reprinting)
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'decommissioned', 'pending_capture')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_openings_building ON openings(building_id);
CREATE INDEX idx_openings_qr_token ON openings(qr_token);

-- ============================================================
-- HARDWARE
-- ============================================================

CREATE TABLE hardware_components (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
    component_type TEXT NOT NULL CHECK (component_type IN (
        'lockset', 'cylinder', 'closer', 'exit_device', 'hinge',
        'automatic_operator', 'panic_bar', 'access_control_reader', 'other'
    )),
    manufacturer TEXT,
    model_number TEXT,
    finish TEXT,
    install_date DATE,
    warranty_expiration DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hardware_opening ON hardware_components(opening_id);
CREATE INDEX idx_hardware_manufacturer_model ON hardware_components(manufacturer, model_number);

-- ============================================================
-- SERVICE & INSPECTION HISTORY
-- ============================================================

CREATE TABLE service_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
    hardware_component_id UUID REFERENCES hardware_components(id),
    performed_by_org_id UUID REFERENCES organizations(id),
    performed_by_user_id UUID REFERENCES users(id),
    event_date DATE NOT NULL,
    work_performed TEXT NOT NULL,
    parts_used TEXT[],
    cost NUMERIC(10,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inspection_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
    performed_by_user_id UUID REFERENCES users(id),
    event_date DATE NOT NULL,
    inspection_type TEXT NOT NULL CHECK (inspection_type IN ('general', 'fire_door_nfpa80', 'ada_compliance', 'access_control')),
    checklist_result JSONB,              -- flexible: store pass/fail per checklist item
    passed BOOLEAN,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- PHOTOS (attached to any of the above via polymorphic reference)
-- ============================================================

CREATE TABLE photos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
    related_entity_type TEXT CHECK (related_entity_type IN ('opening', 'hardware_component', 'service_event', 'inspection_event')),
    related_entity_id UUID,
    storage_url TEXT NOT NULL,
    latitude NUMERIC(9,6),
    longitude NUMERIC(9,6),
    taken_at TIMESTAMPTZ,
    uploaded_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_photos_opening ON photos(opening_id);

-- ============================================================
-- HEALTH SCORE HISTORY (append-only log, current value cached on openings.health_score)
-- ============================================================

CREATE TABLE health_score_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
    score NUMERIC(5,2) NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    factors JSONB   -- store the inputs that produced this score, for auditability/debugging
);

CREATE INDEX idx_health_history_opening ON health_score_history(opening_id, computed_at);
