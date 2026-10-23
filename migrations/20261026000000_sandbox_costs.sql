ALTER TABLE commercial_documents DROP CONSTRAINT commercial_documents_kind_check;
ALTER TABLE commercial_documents ADD CONSTRAINT commercial_documents_kind_check CHECK(kind IN ('technical','cut_sheet','installation','warranty','estimate','invoice','payment_evidence'));
CREATE TABLE sandbox_budget_series (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id),
 property_id UUID NOT NULL REFERENCES properties(id), head_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sandbox_budget_versions (
 id UUID PRIMARY KEY, series_id UUID NOT NULL REFERENCES sandbox_budget_series(id), version INTEGER NOT NULL,
 snapshot JSONB NOT NULL, snapshot_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 recorded_by UUID NOT NULL REFERENCES users(id), recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(series_id,version)
);
CREATE TABLE sandbox_cost_records (
 id UUID PRIMARY KEY, opening_id UUID NOT NULL REFERENCES openings(id),
 organization_id UUID NOT NULL REFERENCES organizations(id), kind TEXT NOT NULL CHECK(kind IN ('invoice','credit','payment')),
 invoice_id UUID REFERENCES sandbox_cost_records(id), correction_of UUID UNIQUE REFERENCES sandbox_cost_records(id),
 payload JSONB NOT NULL, request_hash TEXT NOT NULL, recorded_by UUID NOT NULL REFERENCES users(id),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((kind='invoice' AND invoice_id IS NULL) OR (kind<>'invoice' AND invoice_id IS NOT NULL))
);
CREATE TABLE sandbox_invoice_identity (
 organization_id UUID NOT NULL REFERENCES organizations(id), provider_id UUID NOT NULL REFERENCES organizations(id),
 reference TEXT NOT NULL, invoice_id UUID NOT NULL UNIQUE REFERENCES sandbox_cost_records(id),
 PRIMARY KEY(organization_id,provider_id,reference)
);
CREATE UNIQUE INDEX sandbox_cost_reference_once ON sandbox_cost_records(organization_id,(payload->>'provider_id'),kind,(payload->>'reference')) WHERE correction_of IS NULL AND invoice_id IS NOT NULL;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['sandbox_budget_versions','sandbox_cost_records','sandbox_invoice_identity'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_installation_history()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['sandbox_budget_series','sandbox_budget_versions','sandbox_cost_records','sandbox_invoice_identity'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
   EXECUTE format('GRANT SELECT,INSERT ON %I TO oi_pr2_api',t);
   EXECUTE format('CREATE POLICY server_select ON %I FOR SELECT TO oi_pr2_api USING(true)',t);
   EXECUTE format('CREATE POLICY server_insert ON %I FOR INSERT TO oi_pr2_api WITH CHECK(true)',t);
   IF t='sandbox_budget_series' THEN
    EXECUTE format('GRANT UPDATE ON %I TO oi_pr2_api',t);
    EXECUTE format('CREATE POLICY server_update ON %I FOR UPDATE TO oi_pr2_api USING(true)',t);
   END IF;
  END IF;
 END LOOP;
END $$;
