-- Authorized cumulative test ceiling increased to $5 on 2026-10-07.
-- Defaults stay $2; no trial is opened and no reservation is refunded here.
ALTER TABLE recognition_stability_trials DROP CONSTRAINT recognition_stability_trials_cap_micro_check;
ALTER TABLE recognition_stability_trials ADD CONSTRAINT recognition_stability_trials_cap_micro_check CHECK (cap_micro BETWEEN 1 AND 5000000);
