-- Preserve the storage object identity independently of its delivery URL.
-- A client operation UUID is used as the object filename, making retries
-- idempotent across presign, upload, and confirmation.
ALTER TABLE photos ADD COLUMN storage_key TEXT;

UPDATE photos
SET storage_key = regexp_replace(storage_url, '^https?://[^/]+/', '')
WHERE storage_key IS NULL;

CREATE INDEX idx_photos_storage_key ON photos(storage_key);
