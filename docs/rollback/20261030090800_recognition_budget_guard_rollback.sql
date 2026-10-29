-- Rollback for DRAFT 20261030090800_recognition_budget_guard.sql (restores the 090700 shape).
-- Fails by design if any run is 'refused' (status check); export and decide first.
DROP TRIGGER IF EXISTS opening_active_periods_track ON openings;
DROP FUNCTION IF EXISTS opening_active_periods_track();
DROP TRIGGER IF EXISTS facility_provider_assignment_periods_track ON facility_provider_assignments;
DROP FUNCTION IF EXISTS facility_provider_assignment_periods_track();
-- Billing history is lost on rollback: export both tables first if any month is still unbilled.
DROP TABLE IF EXISTS opening_active_periods;
DROP TABLE IF EXISTS facility_provider_assignment_periods;
-- Provider-owned facilities created by staff are ordinary properties and are NOT removed.
DROP FUNCTION IF EXISTS recognition_usage_reserve(UUID);
DROP TRIGGER IF EXISTS recognition_runs_insert_guard ON recognition_runs;
DROP FUNCTION IF EXISTS recognition_runs_insert_guard();
DROP TABLE IF EXISTS recognition_usage_reservations;
DROP FUNCTION IF EXISTS recognition_usage_reservations_guard();
DROP TABLE IF EXISTS recognition_usage_monthly;
DROP TABLE IF EXISTS recognition_safety_caps;
DROP TABLE IF EXISTS recognition_usage_settings;
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_refused_uncounted;
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_usage_matches_photos;
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_failure_explicit;
ALTER TABLE recognition_runs DROP CONSTRAINT IF EXISTS recognition_runs_status_check;
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_status_check CHECK (status IN ('running','succeeded','abstained','failed','ambiguous'));
ALTER TABLE recognition_runs ADD CONSTRAINT recognition_runs_failure_explicit CHECK ((status IN ('failed','ambiguous')) = (failure_code IS NOT NULL));
ALTER TABLE recognition_runs DROP COLUMN IF EXISTS photo_count, DROP COLUMN IF EXISTS usage_photo_count, DROP COLUMN IF EXISTS downscale_used;
ALTER TABLE recognition_run_photos DROP CONSTRAINT IF EXISTS recognition_run_photos_downscale_complete;
ALTER TABLE recognition_run_photos DROP COLUMN IF EXISTS downscaled, DROP COLUMN IF EXISTS original_byte_size, DROP COLUMN IF EXISTS derived_sha256_checksum,
  DROP COLUMN IF EXISTS derived_byte_size, DROP COLUMN IF EXISTS downscale_method_version, DROP COLUMN IF EXISTS downscale_target,
  DROP COLUMN IF EXISTS derived_width, DROP COLUMN IF EXISTS derived_height;
CREATE OR REPLACE FUNCTION recognition_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recognition_runs_no_delete'; END IF;
  IF OLD.status <> 'running' THEN RAISE EXCEPTION 'recognition_run_finished_is_immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.property_id <> OLD.property_id
     OR NEW.opening_id <> OLD.opening_id OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.client_request_id <> OLD.client_request_id OR NEW.repeat_of_run_id IS DISTINCT FROM OLD.repeat_of_run_id
     OR NEW.mode <> OLD.mode OR NEW.input_source <> OLD.input_source OR NEW.build_commit <> OLD.build_commit
     OR NEW.processing_config <> OLD.processing_config OR NEW.requested_at <> OLD.requested_at
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'recognition_run_immutable_fields';
  END IF;
  RETURN NEW;
END $$;
