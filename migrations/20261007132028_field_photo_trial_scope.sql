-- Additive field-baseline scope; existing single-photo trials stay unchanged.
-- No trial is opened and no permissions are broadened by this migration.
ALTER TABLE recognition_stability_trials ADD COLUMN approved_photo_sets jsonb;
ALTER TABLE recognition_stability_trials ADD CONSTRAINT trial_photo_sets_array
 CHECK (approved_photo_sets IS NULL OR CASE
  WHEN jsonb_typeof(approved_photo_sets)='array'
  THEN jsonb_array_length(approved_photo_sets) BETWEEN 1 AND 10
  ELSE false END);
COMMENT ON COLUMN recognition_stability_trials.approved_photo_sets IS
 'Optional ordered hash arrays for frozen multi-view field cases; photo_sha256 binds their canonical JSON digest. One run per set, existing trial budget applies.';
