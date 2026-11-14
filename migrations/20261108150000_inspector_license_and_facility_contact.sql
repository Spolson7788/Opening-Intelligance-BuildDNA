-- DRAFT. NOT APPLIED to any hosted database.
-- Free-text inspector license number, and an optional facility contact email
-- used as a default recipient for the inspection report.

ALTER TABLE inspection_events ADD COLUMN IF NOT EXISTS inspector_license_number TEXT;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_contact_email_format;
ALTER TABLE properties ADD CONSTRAINT properties_contact_email_format
  CHECK (contact_email IS NULL OR contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
