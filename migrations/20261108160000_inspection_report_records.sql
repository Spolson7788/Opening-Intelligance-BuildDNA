-- A saved fire door inspection report is a document on the opening.
-- The PDF bytes stay in the database. storage_url is a private marker, not a
-- public or token link. One row per inspection, so saving again does not duplicate.
ALTER TABLE documents ADD COLUMN inspection_event_id UUID UNIQUE REFERENCES inspection_events(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN content BYTEA;
ALTER TABLE documents ADD COLUMN content_type TEXT;
