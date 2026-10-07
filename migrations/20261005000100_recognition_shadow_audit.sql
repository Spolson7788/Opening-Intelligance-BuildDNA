CREATE TABLE recognition_provider_attempts (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES recognition_runs(id),
 stage TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL,
 outcome TEXT NOT NULL, latency_ms INTEGER, usage JSONB, cost_usd NUMERIC,
 request_manifest JSONB, cost_basis JSONB, cost_status TEXT NOT NULL DEFAULT 'unknown', raw_output TEXT,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE INDEX recognition_attempt_run ON recognition_provider_attempts(run_id);
ALTER TABLE recognition_provider_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_components ADD COLUMN identity_value_producer TEXT NOT NULL DEFAULT 'unknown'
 CHECK(identity_value_producer IN ('unknown','technician','OCR','AI','catalog'));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON recognition_provider_attempts FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON recognition_provider_attempts FROM authenticated; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT,INSERT,UPDATE ON recognition_provider_attempts TO oi_pr2_api;
  CREATE POLICY api_audit ON recognition_provider_attempts TO oi_pr2_api USING(true) WITH CHECK(true);
 END IF;
END $$;
