-- Paired-opening hierarchy: one opening, one frame, one or two door leaves,
-- and independently identified installed components.

ALTER TABLE openings
  ADD COLUMN opening_configuration TEXT NOT NULL DEFAULT 'single'
    CHECK (opening_configuration IN ('single', 'pair')),
  ADD COLUMN completion_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (completion_state IN ('draft', 'complete')),
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN completed_by_user_id UUID REFERENCES users(id);

CREATE TABLE opening_frames (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opening_id UUID NOT NULL UNIQUE REFERENCES openings(id) ON DELETE CASCADE,
  material TEXT,
  frame_type TEXT,
  width_in NUMERIC(7,3),
  height_in NUMERIC(7,3),
  fire_rated BOOLEAN NOT NULL DEFAULT false,
  condition TEXT CHECK (condition IN ('good', 'worn', 'failed', 'unverified')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (width_in IS NULL OR width_in > 0),
  CHECK (height_in IS NULL OR height_in > 0)
);

CREATE TABLE door_leaves (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  leaf_role TEXT NOT NULL CHECK (leaf_role IN ('single', 'active', 'inactive')),
  handing TEXT,
  material TEXT,
  width_in NUMERIC(7,3),
  height_in NUMERIC(7,3),
  thickness_in NUMERIC(7,3),
  fire_rated BOOLEAN NOT NULL DEFAULT false,
  condition TEXT CHECK (condition IN ('good', 'worn', 'failed', 'unverified')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (opening_id, leaf_role),
  CHECK (width_in IS NULL OR width_in > 0),
  CHECK (height_in IS NULL OR height_in > 0),
  CHECK (thickness_in IS NULL OR thickness_in > 0)
);

CREATE INDEX idx_door_leaves_opening ON door_leaves(opening_id);

ALTER TABLE hardware_components
  ADD COLUMN mounting_scope TEXT NOT NULL DEFAULT 'opening'
    CHECK (mounting_scope IN ('opening', 'frame', 'door_leaf')),
  ADD COLUMN door_leaf_id UUID REFERENCES door_leaves(id) ON DELETE SET NULL,
  ADD COLUMN frame_id UUID REFERENCES opening_frames(id) ON DELETE SET NULL,
  ADD COLUMN position_label TEXT,
  ADD COLUMN client_operation_id UUID,
  ADD COLUMN condition TEXT NOT NULL DEFAULT 'unverified'
    CHECK (condition IN ('good', 'worn', 'failed', 'unverified')),
  ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (identity_status IN ('established', 'unresolved')),
  ADD COLUMN review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'reviewed')),
  ADD COLUMN replacement_required BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX uq_hardware_client_operation
  ON hardware_components(opening_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;
CREATE INDEX idx_hardware_door_leaf ON hardware_components(door_leaf_id);
CREATE INDEX idx_hardware_frame ON hardware_components(frame_id);

ALTER TABLE photos
  ADD COLUMN door_leaf_id UUID REFERENCES door_leaves(id) ON DELETE SET NULL,
  ADD COLUMN frame_id UUID REFERENCES opening_frames(id) ON DELETE SET NULL,
  ADD COLUMN hardware_component_id UUID REFERENCES hardware_components(id) ON DELETE SET NULL,
  ADD COLUMN client_operation_id UUID;

ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_related_entity_type_check;
ALTER TABLE photos ADD CONSTRAINT photos_related_entity_type_check CHECK (
  related_entity_type IN (
    'opening', 'frame', 'door_leaf', 'hardware_component', 'service_event', 'inspection_event'
  )
);

CREATE UNIQUE INDEX uq_photos_client_operation
  ON photos(opening_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;
CREATE INDEX idx_photos_door_leaf ON photos(door_leaf_id);
CREATE INDEX idx_photos_frame ON photos(frame_id);
CREATE INDEX idx_photos_hardware_component ON photos(hardware_component_id);

-- Existing openings and hardware remain valid and are deliberately not assigned
-- to a leaf. Their physical leaf cannot be inferred safely from legacy data.
