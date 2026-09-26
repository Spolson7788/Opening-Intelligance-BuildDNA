-- Canonical API assignments. No existing facility is granted to a provider.
CREATE TABLE facility_provider_assignments (
 property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 provider_organization_id UUID NOT NULL REFERENCES organizations(id),
 granted_by_user_id UUID NOT NULL REFERENCES users(id),
 granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 revoked_at TIMESTAMPTZ,
 PRIMARY KEY(property_id,provider_organization_id)
);
CREATE INDEX facility_provider_active ON facility_provider_assignments(provider_organization_id,property_id) WHERE revoked_at IS NULL;
ALTER TABLE facility_provider_assignments ENABLE ROW LEVEL SECURITY;
-- Approval is bound to the exact component identity; generic uploaded documents do not qualify.
CREATE TABLE component_purchasing_approvals (
 component_id UUID PRIMARY KEY REFERENCES hardware_components(id) ON DELETE CASCADE,
 manufacturer TEXT NOT NULL CHECK(length(trim(manufacturer))>0),
 model_number TEXT NOT NULL CHECK(length(trim(model_number))>0),
 component_type TEXT NOT NULL,
 document_url TEXT NOT NULL CHECK(document_url ~ '^https://'),
 document_sha256 TEXT NOT NULL CHECK(document_sha256 ~ '^[0-9a-f]{64}$'),
 provenance TEXT NOT NULL CHECK(provenance IN ('technician_selected','oi_established')),
 approved_by_user_id UUID NOT NULL REFERENCES users(id),
 approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 revoked_at TIMESTAMPTZ
);
ALTER TABLE component_purchasing_approvals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON facility_provider_assignments,component_purchasing_approvals FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON facility_provider_assignments,component_purchasing_approvals FROM authenticated;
 END IF;
END $$;
