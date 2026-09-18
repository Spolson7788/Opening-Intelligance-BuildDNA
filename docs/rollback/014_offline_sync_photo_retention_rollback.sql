DROP INDEX IF EXISTS idx_photos_storage_key;
ALTER TABLE photos DROP COLUMN IF EXISTS storage_key;
