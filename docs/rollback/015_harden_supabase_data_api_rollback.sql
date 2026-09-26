-- Security-preserving recovery for migration 015.
-- Migration 015 only enables RLS. Reversing it by disabling RLS would reopen
-- exposed public-schema tables to roles that may already hold Data API grants.
-- The safe recovery action is therefore to retain RLS and explicitly revoke
-- browser-role access until replacement policies have been reviewed.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE door_leaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_schedules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON organizations, users, portfolios, properties, buildings,
      openings, opening_frames, door_leaves, hardware_components,
      service_events, inspection_events, photos, health_score_history,
      audit_log, documents, work_orders, maintenance_schedules FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON organizations, users, portfolios, properties, buildings,
      openings, opening_frames, door_leaves, hardware_components,
      service_events, inspection_events, photos, health_score_history,
      audit_log, documents, work_orders, maintenance_schedules FROM authenticated;
  END IF;
END $$;
