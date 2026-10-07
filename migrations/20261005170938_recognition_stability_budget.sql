-- Additive, nonproduction trial control. No trial is enabled by this migration.
CREATE TABLE recognition_stability_trials (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id),
 opening_id uuid NOT NULL REFERENCES openings(id),
 photo_sha256 text NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
 cap_micro integer NOT NULL DEFAULT 2000000 CHECK (cap_micro BETWEEN 1 AND 2000000),
 max_runs integer NOT NULL DEFAULT 10 CHECK (max_runs BETWEEN 1 AND 10),
 state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','paused','closed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recognition_stability_runs (
 trial_id uuid NOT NULL REFERENCES recognition_stability_trials(id),
 run_id uuid PRIMARY KEY REFERENCES recognition_runs(id),
 request_id uuid NOT NULL,
 UNIQUE (trial_id,request_id)
);
CREATE TABLE recognition_stability_reservations (
 attempt_id uuid PRIMARY KEY REFERENCES recognition_provider_attempts(id),
 trial_id uuid NOT NULL REFERENCES recognition_stability_trials(id),
 maximum_micro integer NOT NULL CHECK (maximum_micro > 0),
 charged_micro integer NOT NULL CHECK (charged_micro >= 0),
 outcome text NOT NULL DEFAULT 'reserved' CHECK (outcome IN ('reserved','settled','unknown')),
 CHECK (charged_micro <= maximum_micro)
);
CREATE INDEX recognition_stability_reservations_trial ON recognition_stability_reservations(trial_id);
ALTER TABLE recognition_stability_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_stability_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_stability_reservations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON recognition_stability_trials,recognition_stability_runs,recognition_stability_reservations FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON recognition_stability_trials,recognition_stability_runs,recognition_stability_reservations FROM authenticated; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT,INSERT,UPDATE ON recognition_stability_trials,recognition_stability_runs,recognition_stability_reservations TO oi_pr2_api;
  CREATE POLICY api_trial ON recognition_stability_trials TO oi_pr2_api USING(true) WITH CHECK(true);
  CREATE POLICY api_trial_runs ON recognition_stability_runs TO oi_pr2_api USING(true) WITH CHECK(true);
  CREATE POLICY api_trial_reservations ON recognition_stability_reservations TO oi_pr2_api USING(true) WITH CHECK(true);
 END IF;
END $$;
