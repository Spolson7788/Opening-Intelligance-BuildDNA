-- DRAFT. NOT APPLIED to any hosted database.
-- Columns for the dated official combined-report PDF. Safe to run after the
-- visit table draft, and a no-op when that draft already created the columns.

ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_storage_key TEXT;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_sha256 TEXT;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_generated_at TIMESTAMPTZ;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_generated_by UUID REFERENCES users(id);
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_sent_at TIMESTAMPTZ;
ALTER TABLE inspection_visits ADD COLUMN IF NOT EXISTS report_recipients TEXT;
