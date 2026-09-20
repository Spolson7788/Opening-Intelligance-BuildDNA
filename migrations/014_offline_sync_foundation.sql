-- Offline synchronization foundation.
-- Additive only: existing connected behavior remains valid while the new
-- idempotent protocol is introduced behind dedicated endpoints.

ALTER TABLE openings
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN client_operation_id UUID;

CREATE UNIQUE INDEX uq_openings_client_operation
  ON openings(client_operation_id)
  WHERE client_operation_id IS NOT NULL;

ALTER TABLE opening_frames
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN client_operation_id UUID;

CREATE UNIQUE INDEX uq_opening_frames_client_operation
  ON opening_frames(client_operation_id)
  WHERE client_operation_id IS NOT NULL;

ALTER TABLE door_leaves
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN client_operation_id UUID;

CREATE UNIQUE INDEX uq_door_leaves_client_operation
  ON door_leaves(client_operation_id)
  WHERE client_operation_id IS NOT NULL;

ALTER TABLE hardware_components
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE service_events
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN client_operation_id UUID;

CREATE UNIQUE INDEX uq_service_events_client_operation
  ON service_events(opening_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

ALTER TABLE inspection_events
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN client_operation_id UUID;

CREATE UNIQUE INDEX uq_inspection_events_client_operation
  ON inspection_events(opening_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

ALTER TABLE photos
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN organization_id UUID REFERENCES organizations(id),
  ADD COLUMN original_filename TEXT,
  ADD COLUMN content_type TEXT,
  ADD COLUMN byte_size BIGINT,
  ADD COLUMN sha256_checksum TEXT,
  ADD COLUMN storage_object_key TEXT,
  ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'legacy_confirmed'
    CHECK (upload_state IN ('reserved', 'uploaded', 'verified', 'failed', 'legacy_confirmed')),
  ADD COLUMN storage_verified_at TIMESTAMPTZ,
  ADD COLUMN authorized_retrieval_verified_at TIMESTAMPTZ,
  ADD COLUMN captured_by_device_id UUID,
  ADD CONSTRAINT photos_byte_size_positive CHECK (byte_size IS NULL OR byte_size > 0),
  ADD CONSTRAINT photos_sha256_format CHECK (
    sha256_checksum IS NULL OR sha256_checksum ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX uq_photos_storage_object_key
  ON photos(storage_object_key)
  WHERE storage_object_key IS NOT NULL;
CREATE INDEX idx_photos_organization ON photos(organization_id);
CREATE INDEX idx_photos_upload_state ON photos(upload_state);

-- One canonical private-object identity. Legacy URL-derived values are copied
-- only when present; new private media never relies on a delivery URL.
UPDATE photos
SET storage_object_key = regexp_replace(storage_url, '^https?://[^/]+/', '')
WHERE storage_object_key IS NULL
  AND storage_url IS NOT NULL
  AND storage_url ~ '^https?://';

CREATE TABLE sync_operation_receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  operation_type TEXT NOT NULL CHECK (
    operation_type IN ('create', 'update', 'complete', 'upload_media', 'confirm_media', 'tombstone')
  ),
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'opening', 'frame', 'door_leaf', 'component', 'photo',
      'service_event', 'inspection_event', 'completion', 'purchasing_review'
    )
  ),
  entity_id UUID NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  base_server_revision BIGINT,
  resulting_server_revision BIGINT NOT NULL CHECK (resulting_server_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'already_applied')),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  device_id UUID NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  app_version TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
  normalized_record_hash TEXT NOT NULL CHECK (normalized_record_hash ~ '^[0-9a-f]{64}$'),
  media_object_verified BOOLEAN NOT NULL DEFAULT false,
  authorized_retrieval_verified BOOLEAN NOT NULL DEFAULT false,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  server_accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, operation_id)
);

CREATE INDEX idx_sync_receipts_opening_created
  ON sync_operation_receipts(opening_id, server_accepted_at DESC);
CREATE INDEX idx_sync_receipts_entity
  ON sync_operation_receipts(entity_type, entity_id);

CREATE TABLE sync_audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  base_server_revision BIGINT,
  resulting_server_revision BIGINT,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  device_id UUID NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  event_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_audit_opening_created
  ON sync_audit_events(opening_id, created_at DESC);
CREATE INDEX idx_sync_audit_operation ON sync_audit_events(operation_id);

CREATE TABLE photo_upload_reservations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (
    target_type IN ('opening', 'frame', 'door_leaf', 'hardware_component', 'service_event', 'inspection_event')
  ),
  target_id UUID NOT NULL,
  upload_object_key TEXT NOT NULL UNIQUE,
  storage_object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256_checksum TEXT NOT NULL CHECK (sha256_checksum ~ '^[0-9a-f]{64}$'),
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  device_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'uploaded', 'verified', 'failed')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  uploaded_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  failure_code TEXT,
  UNIQUE (organization_id, operation_id),
  UNIQUE (organization_id, photo_id)
);

CREATE INDEX idx_photo_reservations_opening_status
  ON photo_upload_reservations(opening_id, status);
CREATE INDEX idx_photo_reservations_expiry
  ON photo_upload_reservations(expires_at)
  WHERE status = 'reserved';

CREATE TABLE photo_deletion_jobs (
  photo_id UUID PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  storage_object_key TEXT NOT NULL,
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry_wait')),
  last_error_code TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ
);

CREATE INDEX idx_photo_deletion_jobs_retry
  ON photo_deletion_jobs(status, last_attempt_at);

-- These tables are internal to the API server until a separately reviewed
-- Supabase Data API contract exists. RLS plus explicit revoked grants prevents
-- accidental direct-browser exposure; the application server's direct
-- Postgres connection continues to enforce tenant checks in its routes.
ALTER TABLE sync_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_upload_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_deletion_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sync_operation_receipts FROM PUBLIC;
REVOKE ALL ON sync_audit_events FROM PUBLIC;
REVOKE ALL ON photo_upload_reservations FROM PUBLIC;
REVOKE ALL ON photo_deletion_jobs FROM PUBLIC;

-- Supabase projects may have explicit default grants for these roles. Keep the
-- migration portable to ordinary Postgres/PGlite, where the roles do not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON sync_operation_receipts, sync_audit_events, photo_upload_reservations, photo_deletion_jobs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON sync_operation_receipts, sync_audit_events, photo_upload_reservations, photo_deletion_jobs FROM authenticated;
  END IF;
END $$;
