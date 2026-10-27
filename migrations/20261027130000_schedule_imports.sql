-- M2 schedule imports: parse a stored door schedule version (and optionally a
-- door hardware schedule version) for ONE chosen building, preview the change
-- plan, and confirm it. Additive only: new tables plus one nullable column and
-- a partial unique index on openings. No existing row is altered or deleted.
--
-- Access: same as M1. API-enforced through tenantScope (facility owner org or an
-- active provider assignment; admin / facilities_manager only). RLS on, deny
-- all here; Data API grants/policies live in the hosted review-only bundle.
ALTER TABLE openings ADD COLUMN schedule_door_mark TEXT
 CHECK (schedule_door_mark IS NULL OR (length(schedule_door_mark) BETWEEN 1 AND 40 AND schedule_door_mark = upper(btrim(schedule_door_mark))));
CREATE UNIQUE INDEX openings_building_schedule_mark ON openings(building_id, schedule_door_mark) WHERE schedule_door_mark IS NOT NULL;

CREATE TABLE schedule_imports (
 id UUID PRIMARY KEY,
 property_id UUID NOT NULL REFERENCES properties(id),
 building_id UUID NOT NULL REFERENCES buildings(id),
 door_version_id UUID NOT NULL REFERENCES facility_schedule_versions(id),
 hardware_version_id UUID REFERENCES facility_schedule_versions(id),
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
 parse_report JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_by_user_id UUID NOT NULL REFERENCES users(id),
 created_by_organization_id UUID NOT NULL REFERENCES organizations(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 resolutions JSONB,
 result JSONB,
 confirmed_by_user_id UUID REFERENCES users(id),
 confirmed_at TIMESTAMPTZ,
 CHECK ((status='draft' AND confirmed_at IS NULL) OR (status='confirmed' AND confirmed_at IS NOT NULL AND confirmed_by_user_id IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX schedule_imports_property ON schedule_imports(property_id, created_at DESC);

CREATE TABLE schedule_rows (
 id UUID PRIMARY KEY,
 import_id UUID NOT NULL REFERENCES schedule_imports(id),
 row_kind TEXT NOT NULL CHECK (row_kind IN ('door','type_template')),
 schedule_name TEXT,
 source_sheet TEXT,
 source_row INTEGER NOT NULL,
 raw JSONB NOT NULL,
 door_mark_raw TEXT,
 door_mark TEXT,
 room_name TEXT, room_number TEXT, to_room TEXT,
 elevation_type TEXT, configuration TEXT, description TEXT,
 width_in NUMERIC, height_in NUMERIC, thickness_in NUMERIC,
 door_material TEXT, frame_material TEXT,
 fire_rating_raw TEXT, fire_rating_minutes INTEGER,
 hw_ref_raw TEXT, hw_set_key TEXT,
 closer TEXT, comments TEXT,
 issues JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX schedule_rows_import ON schedule_rows(import_id, source_row);

CREATE TABLE schedule_hardware_sets (
 id UUID PRIMARY KEY,
 import_id UUID NOT NULL REFERENCES schedule_imports(id),
 set_key TEXT NOT NULL,
 heading_raw TEXT NOT NULL,
 notes TEXT,
 furnished_by_others BOOLEAN NOT NULL DEFAULT false,
 source_table INTEGER NOT NULL,
 UNIQUE (import_id, set_key)
);

CREATE TABLE schedule_set_items (
 id UUID PRIMARY KEY,
 set_id UUID NOT NULL REFERENCES schedule_hardware_sets(id),
 import_id UUID NOT NULL REFERENCES schedule_imports(id),
 position INTEGER NOT NULL,
 qty INTEGER,
 description TEXT NOT NULL,
 catalog_raw TEXT, catalog TEXT, finish TEXT, finish_bhma TEXT, options TEXT,
 manufacturer_raw TEXT, manufacturer TEXT,
 furnished_by TEXT,
 item_type TEXT NOT NULL,
 component_type TEXT NOT NULL,
 needs_review BOOLEAN NOT NULL DEFAULT false,
 review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
 UNIQUE (set_id, position)
);

-- Provenance of every confirmed change (audit + idempotency). Append only.
CREATE TABLE schedule_import_effects (
 id UUID PRIMARY KEY,
 import_id UUID NOT NULL REFERENCES schedule_imports(id),
 entity_type TEXT NOT NULL CHECK (entity_type IN ('opening','door_leaf','frame','hardware')),
 entity_id UUID NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('create','update')),
 field TEXT,
 old_value JSONB,
 new_value JSONB,
 item_signature TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX schedule_import_effects_entity ON schedule_import_effects(entity_type, entity_id);

CREATE FUNCTION schedule_import_children_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER schedule_rows_no_change BEFORE UPDATE OR DELETE ON schedule_rows FOR EACH ROW EXECUTE FUNCTION schedule_import_children_immutable();
CREATE TRIGGER schedule_sets_no_change BEFORE UPDATE OR DELETE ON schedule_hardware_sets FOR EACH ROW EXECUTE FUNCTION schedule_import_children_immutable();
CREATE TRIGGER schedule_items_no_change BEFORE UPDATE OR DELETE ON schedule_set_items FOR EACH ROW EXECUTE FUNCTION schedule_import_children_immutable();
CREATE TRIGGER schedule_effects_no_change BEFORE UPDATE OR DELETE ON schedule_import_effects FOR EACH ROW EXECUTE FUNCTION schedule_import_children_immutable();

-- An import may only move draft -> confirmed once and is never deleted.
CREATE FUNCTION schedule_imports_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'schedule_imports are never deleted'; END IF;
 IF OLD.status='confirmed' THEN RAISE EXCEPTION 'confirmed schedule import is immutable'; END IF;
 IF NEW.id<>OLD.id OR NEW.property_id<>OLD.property_id OR NEW.building_id<>OLD.building_id OR NEW.door_version_id<>OLD.door_version_id
  OR NEW.hardware_version_id IS DISTINCT FROM OLD.hardware_version_id OR NEW.parse_report<>OLD.parse_report THEN
  RAISE EXCEPTION 'schedule import source is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_imports_guard BEFORE UPDATE OR DELETE ON schedule_imports FOR EACH ROW EXECUTE FUNCTION schedule_imports_guard();

ALTER TABLE schedule_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_hardware_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_set_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_import_effects ENABLE ROW LEVEL SECURITY;
