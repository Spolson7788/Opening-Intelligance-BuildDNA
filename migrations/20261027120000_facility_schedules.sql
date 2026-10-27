-- M1 facility schedule storage: door schedules and door hardware schedules
-- uploaded to a facility (property). Additive only: no existing table, row or
-- retained staging data is altered. No parsing; files are stored as immutable
-- versions identified by sha256.
--
-- Access: the facility owner organization (via portfolio) or a provider
-- organization with an active facility_provider_assignments row (existing
-- table from 20260926175036). Enforced in the API through tenantScope.
-- Deliberately NO role grants/policies for the Data API (RLS on, deny all).
CREATE TABLE facility_schedules (
 id UUID PRIMARY KEY,
 property_id UUID NOT NULL REFERENCES properties(id),
 created_by_organization_id UUID NOT NULL REFERENCES organizations(id),
 created_by_user_id UUID NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK (kind IN ('door','hardware')),
 title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
 head_version INTEGER NOT NULL DEFAULT 0 CHECK (head_version >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX facility_schedules_property ON facility_schedules(property_id, kind);

CREATE TABLE facility_schedule_versions (
 id UUID PRIMARY KEY,
 schedule_id UUID NOT NULL REFERENCES facility_schedules(id),
 version INTEGER NOT NULL CHECK (version >= 1),
 storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 500),
 original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
 content_type TEXT NOT NULL CHECK (content_type IN (
  'application/pdf','text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
 sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 uploaded_by_user_id UUID NOT NULL REFERENCES users(id),
 uploaded_by_organization_id UUID NOT NULL REFERENCES organizations(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (schedule_id, version)
);

-- Versions are immutable evidence: no UPDATE or DELETE, ever.
CREATE FUNCTION facility_schedule_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'facility_schedule_versions are immutable';
END $$;
CREATE TRIGGER facility_schedule_versions_no_change
 BEFORE UPDATE OR DELETE ON facility_schedule_versions
 FOR EACH ROW EXECUTE FUNCTION facility_schedule_versions_immutable();

ALTER TABLE facility_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_schedule_versions ENABLE ROW LEVEL SECURITY;
