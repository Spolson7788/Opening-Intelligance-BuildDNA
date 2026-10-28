-- M4: saved schedule-vs-field comparison snapshots. Additive only: one new
-- append-only table and its immutability trigger. No existing row is changed.
--
-- A snapshot is the output of the on-demand comparison engine
-- (src/services/scheduleComparison.ts) for ONE confirmed schedule import,
-- frozen at the moment someone pressed "Run comparison". It records who ran
-- it, when, the import, a summary of counts and the full per-opening results.
-- Snapshots are read-only once written (no UPDATE, no DELETE).
--
-- Access: API-enforced through tenantScope (facility owner org or an active
-- provider assignment; admin / facilities_manager / technician / inspector).
-- RLS on, deny all here; Data API grants/policies live in the hosted bundle.
-- Undo: docs/rollback/20261028150000_schedule_comparison_snapshots_rollback.sql
CREATE TABLE schedule_comparison_snapshots (
 id UUID PRIMARY KEY,
 import_id UUID NOT NULL REFERENCES schedule_imports(id),
 property_id UUID NOT NULL REFERENCES properties(id),
 building_id UUID NOT NULL REFERENCES buildings(id),
 engine_version INTEGER NOT NULL CHECK (engine_version > 0),
 summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
 results JSONB NOT NULL CHECK (jsonb_typeof(results) = 'array'),
 opening_count INTEGER NOT NULL CHECK (opening_count >= 0),
 line_count INTEGER NOT NULL CHECK (line_count >= 0),
 created_by_user_id UUID NOT NULL REFERENCES users(id),
 created_by_organization_id UUID NOT NULL REFERENCES organizations(id),
 created_by_role TEXT NOT NULL CHECK (created_by_role IN ('admin','facilities_manager','technician','inspector')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX schedule_comparison_snapshots_import ON schedule_comparison_snapshots(import_id, created_at DESC);

CREATE FUNCTION schedule_comparison_snapshots_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'schedule_comparison_snapshots are read-only once written';
END $$;
CREATE TRIGGER schedule_comparison_snapshots_no_change
 BEFORE UPDATE OR DELETE ON schedule_comparison_snapshots
 FOR EACH ROW EXECUTE FUNCTION schedule_comparison_snapshots_immutable();

-- Only confirmed imports can be compared, and property/building must match the import.
CREATE FUNCTION schedule_comparison_snapshots_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM schedule_imports i WHERE i.id = NEW.import_id AND i.status = 'confirmed'
                AND i.property_id = NEW.property_id AND i.building_id = NEW.building_id) THEN
  RAISE EXCEPTION 'comparison snapshot needs a confirmed import with matching property and building';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_comparison_snapshots_check
 BEFORE INSERT ON schedule_comparison_snapshots
 FOR EACH ROW EXECUTE FUNCTION schedule_comparison_snapshots_check();

ALTER TABLE schedule_comparison_snapshots ENABLE ROW LEVEL SECURITY;