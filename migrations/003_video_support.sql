-- Add media_type support so the photos table can hold videos, not just images.
-- Existing rows default to 'photo' (they all were, before this migration).

ALTER TABLE photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'photo' CHECK (media_type IN ('photo', 'video'));
