-- Explicit rollback for migration 013. Run only after exporting the new tables
-- and columns: this removes paired-opening data that cannot fit the legacy model.
BEGIN;

DROP INDEX IF EXISTS uq_photos_client_operation;
DROP INDEX IF EXISTS idx_photos_door_leaf;
DROP INDEX IF EXISTS idx_photos_frame;
DROP INDEX IF EXISTS idx_photos_hardware_component;
ALTER TABLE photos DROP COLUMN IF EXISTS client_operation_id;
ALTER TABLE photos DROP COLUMN IF EXISTS hardware_component_id;
ALTER TABLE photos DROP COLUMN IF EXISTS frame_id;
ALTER TABLE photos DROP COLUMN IF EXISTS door_leaf_id;
ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_related_entity_type_check;
ALTER TABLE photos ADD CONSTRAINT photos_related_entity_type_check CHECK (
  related_entity_type IN ('opening', 'hardware_component', 'service_event', 'inspection_event')
);

DROP INDEX IF EXISTS uq_hardware_client_operation;
DROP INDEX IF EXISTS idx_hardware_door_leaf;
DROP INDEX IF EXISTS idx_hardware_frame;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS client_operation_id;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS replacement_required;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS review_state;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS identity_status;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS condition;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS position_label;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS frame_id;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS door_leaf_id;
ALTER TABLE hardware_components DROP COLUMN IF EXISTS mounting_scope;

DROP TABLE IF EXISTS door_leaves;
DROP TABLE IF EXISTS opening_frames;

ALTER TABLE openings DROP COLUMN IF EXISTS completed_by_user_id;
ALTER TABLE openings DROP COLUMN IF EXISTS completed_at;
ALTER TABLE openings DROP COLUMN IF EXISTS completion_state;
ALTER TABLE openings DROP COLUMN IF EXISTS opening_configuration;

COMMIT;
