-- Bounded photo-set trial ceiling; no new run or spending authorization.
ALTER TABLE recognition_stability_trials DROP CONSTRAINT recognition_stability_trials_max_runs_check;
ALTER TABLE recognition_stability_trials ADD CONSTRAINT recognition_stability_trials_max_runs_check CHECK (max_runs BETWEEN 1 AND 18);
COMMENT ON CONSTRAINT recognition_stability_trials_max_runs_check ON recognition_stability_trials IS 'At most ten frozen photo sets plus eight explicitly audited replays. Application scope checks and spend cap still apply; raising this ceiling grants no runs.';
