-- Sandbox records never constitute financial approval, issuance or actual costs.
CREATE TABLE sandbox_plans (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id),
 opening_id UUID NOT NULL REFERENCES openings(id), kind TEXT NOT NULL CHECK(kind IN ('order','scenario')),
 head_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sandbox_plan_versions (
 id UUID PRIMARY KEY, plan_id UUID NOT NULL REFERENCES sandbox_plans(id), version INTEGER NOT NULL,
 snapshot JSONB NOT NULL, snapshot_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 recorded_by UUID NOT NULL REFERENCES users(id), recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(plan_id,version)
);
CREATE TABLE sandbox_plan_events (
 id UUID PRIMARY KEY, version_id UUID NOT NULL REFERENCES sandbox_plan_versions(id),
 actor_id UUID NOT NULL REFERENCES users(id), action TEXT NOT NULL CHECK(action IN ('draft_created','review_requested')),
 request_hash TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sandbox_delivery_holds (
 version_id UUID PRIMARY KEY REFERENCES sandbox_plan_versions(id),
 state TEXT NOT NULL CHECK(state IN ('disabled','superseded')), reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['sandbox_plan_versions','sandbox_plan_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_installation_history()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['sandbox_plans','sandbox_plan_versions','sandbox_plan_events','sandbox_delivery_holds'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
   EXECUTE format('GRANT SELECT,INSERT ON %I TO oi_pr2_api',t);
   EXECUTE format('CREATE POLICY server_select ON %I FOR SELECT TO oi_pr2_api USING(true)',t);
   EXECUTE format('CREATE POLICY server_insert ON %I FOR INSERT TO oi_pr2_api WITH CHECK(true)',t);
   IF t IN ('sandbox_plans','sandbox_delivery_holds') THEN
    EXECUTE format('GRANT UPDATE ON %I TO oi_pr2_api',t);
    EXECUTE format('CREATE POLICY server_update ON %I FOR UPDATE TO oi_pr2_api USING(true) WITH CHECK(true)',t);
   END IF;
  END IF;
 END LOOP;
END $$;
