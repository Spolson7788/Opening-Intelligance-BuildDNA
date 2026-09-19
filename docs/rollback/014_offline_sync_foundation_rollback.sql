-- Destructive rollback for migration 014. Do not use after offline-sync data
-- has been accepted without first exporting receipts, audit events, media
-- metadata, and any client-generated identities.

DROP TABLE IF EXISTS photo_deletion_jobs;
DROP TABLE IF EXISTS photo_upload_reservations;
DROP TABLE IF EXISTS sync_audit_events;
DROP TABLE IF EXISTS sync_operation_receipts;

DROP INDEX IF EXISTS idx_photos_upload_state;
DROP INDEX IF EXISTS idx_photos_organization;
DROP INDEX IF EXISTS uq_photos_storage_object_key;

ALTER TABLE photos
  DROP CONSTRAINT IF EXISTS photos_sha256_format,
  DROP CONSTRAINT IF EXISTS photos_byte_size_positive,
  DROP COLUMN IF EXISTS captured_by_device_id,
  DROP COLUMN IF EXISTS authorized_retrieval_verified_at,
  DROP COLUMN IF EXISTS storage_verified_at,
  DROP COLUMN IF EXISTS upload_state,
  DROP COLUMN IF EXISTS storage_object_key,
  DROP COLUMN IF EXISTS sha256_checksum,
  DROP COLUMN IF EXISTS byte_size,
  DROP COLUMN IF EXISTS content_type,
  DROP COLUMN IF EXISTS original_filename,
  DROP COLUMN IF EXISTS organization_id,
  DROP COLUMN IF EXISTS revision;

DROP INDEX IF EXISTS uq_inspection_events_client_operation;
ALTER TABLE inspection_events
  DROP COLUMN IF EXISTS client_operation_id,
  DROP COLUMN IF EXISTS revision;

DROP INDEX IF EXISTS uq_service_events_client_operation;
ALTER TABLE service_events
  DROP COLUMN IF EXISTS client_operation_id,
  DROP COLUMN IF EXISTS revision;

ALTER TABLE hardware_components DROP COLUMN IF EXISTS revision;

DROP INDEX IF EXISTS uq_door_leaves_client_operation;
ALTER TABLE door_leaves
  DROP COLUMN IF EXISTS client_operation_id,
  DROP COLUMN IF EXISTS revision;

DROP INDEX IF EXISTS uq_opening_frames_client_operation;
ALTER TABLE opening_frames
  DROP COLUMN IF EXISTS client_operation_id,
  DROP COLUMN IF EXISTS revision;

DROP INDEX IF EXISTS uq_openings_client_operation;
ALTER TABLE openings
  DROP COLUMN IF EXISTS client_operation_id,
  DROP COLUMN IF EXISTS revision;
