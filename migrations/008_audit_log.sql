-- Who changed what, when. Scoped deliberately to successful mutations only
-- (2xx write requests) — not every GET request (too noisy to be useful as
-- an audit trail rather than a request log), and not blocked/403 attempts
-- either (that's a genuinely different feature — a security event log —
-- not "who changed what," and conflating the two would make this table
-- harder to read for its actual purpose).
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id), -- who did it; joined against users at read time
                                                  -- rather than denormalizing email here — users
                                                  -- are never hard-deleted (is_active soft-delete,
                                                  -- see migration 007), so the join always resolves.
    action TEXT NOT NULL,     -- human-readable label, e.g. "Created opening"
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_body JSONB,       -- redacted (no password fields) snapshot of what was submitted
    status_code INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_org_created ON audit_log(organization_id, created_at DESC);
