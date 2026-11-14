-- DRAFT. NOT APPLIED to any hosted database.
-- Purchasing department address for a provider company, with an optional branch override.
-- Each send is kept: who, when, where, which opening and component, and which files.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS purchasing_email TEXT;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_purchasing_email_format;
ALTER TABLE organizations ADD CONSTRAINT organizations_purchasing_email_format
  CHECK (purchasing_email IS NULL OR purchasing_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

ALTER TABLE company_branches ADD COLUMN IF NOT EXISTS purchasing_email TEXT;
ALTER TABLE company_branches DROP CONSTRAINT IF EXISTS company_branches_purchasing_email_format;
ALTER TABLE company_branches ADD CONSTRAINT company_branches_purchasing_email_format
  CHECK (purchasing_email IS NULL OR purchasing_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

CREATE TABLE IF NOT EXISTS purchasing_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  opening_id UUID NOT NULL REFERENCES openings(id),
  hardware_component_id UUID NOT NULL REFERENCES hardware_components(id),
  sent_by_user_id UUID NOT NULL REFERENCES users(id),
  sent_to TEXT NOT NULL,
  note TEXT,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('attachments', 'links')),
  document_ids UUID[] NOT NULL DEFAULT '{}',
  reference_sha256s TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchasing_sends_opening ON purchasing_sends(opening_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchasing_send_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id UUID NOT NULL REFERENCES purchasing_sends(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content BYTEA,
  link_url TEXT,
  source_document_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purchasing_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchasing_send_files ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT ON purchasing_sends, purchasing_send_files TO oi_pr2_api;
  END IF;
END $$;

DO $$ DECLARE roles text; r record; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('purchasing_sends', 'purchasing_send_files')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM %s', r.t, roles); END IF;
  END LOOP;
END $$;
