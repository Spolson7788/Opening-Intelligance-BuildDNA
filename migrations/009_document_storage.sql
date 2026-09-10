-- Document storage: warranty certificates, service contracts, insurance
-- policies — real files, not just data fields. A document can attach to a
-- property alone (a property-wide insurance policy) or to a specific
-- opening (a warranty certificate for one door's hardware) — at least one
-- of the two is required, enforced by the CHECK constraint below.
--
-- No organization_id column here on purpose — tenant scope is derived by
-- joining through property_id or opening_id (through buildings/properties/
-- portfolios), the same convention already used everywhere else in this
-- schema (see src/db/tenantScope.ts) rather than denormalizing org
-- ownership onto every table and risking it drifting out of sync with the
-- real ownership chain.
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
    opening_id UUID REFERENCES openings(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN (
        'warranty', 'service_contract', 'insurance', 'inspection_report', 'other'
    )),
    title TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    file_size_bytes INT,
    uploaded_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT documents_must_attach_to_something CHECK (property_id IS NOT NULL OR opening_id IS NOT NULL)
);

CREATE INDEX idx_documents_property ON documents(property_id);
CREATE INDEX idx_documents_opening ON documents(opening_id);
