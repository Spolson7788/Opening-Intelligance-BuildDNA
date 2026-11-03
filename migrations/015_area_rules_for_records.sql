-- Extend facility-area enforcement to documents, maintenance schedules,
-- and work-order inserts. Uses the same oi_private coverage functions as
-- facility and opening access. Additive: no existing rows are rewritten.

CREATE OR REPLACE FUNCTION oi_private.can_read_document(
    p_user_id uuid,
    p_property_id uuid,
    p_opening_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (p_property_id IS NOT NULL OR p_opening_id IS NOT NULL)
    AND (p_property_id IS NULL OR oi_private.can_read_property(p_user_id, p_property_id))
    AND (p_opening_id IS NULL OR oi_private.can_work_opening(p_user_id, p_opening_id));
$$;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_select ON documents
  FOR SELECT USING (
    oi_private.can_read_document(oi_private.current_user_id(), property_id, opening_id)
  );

CREATE POLICY documents_insert ON documents
  FOR INSERT WITH CHECK (
    oi_private.can_read_document(oi_private.current_user_id(), property_id, opening_id)
  );

CREATE POLICY documents_delete ON documents
  FOR DELETE USING (
    oi_private.can_read_document(oi_private.current_user_id(), property_id, opening_id)
  );

CREATE POLICY maintenance_schedules_select ON maintenance_schedules
  FOR SELECT USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY maintenance_schedules_insert ON maintenance_schedules
  FOR INSERT WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY maintenance_schedules_update ON maintenance_schedules
  FOR UPDATE
  USING (oi_private.can_work_opening(oi_private.current_user_id(), opening_id))
  WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

CREATE POLICY work_orders_insert ON work_orders
  FOR INSERT WITH CHECK (oi_private.can_work_opening(oi_private.current_user_id(), opening_id));

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['documents', 'maintenance_schedules', 'work_orders']
    LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated',
        t
      );
    END LOOP;
  END IF;
END $$;
