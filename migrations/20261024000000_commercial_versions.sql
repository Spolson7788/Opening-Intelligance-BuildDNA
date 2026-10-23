CREATE TABLE commercial_documents (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id),
 property_id UUID REFERENCES properties(id), title TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('technical','cut_sheet','installation','warranty','estimate')),
 head_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE commercial_document_versions (
 id UUID PRIMARY KEY, document_id UUID NOT NULL REFERENCES commercial_documents(id), version INTEGER NOT NULL,
 verified_at TIMESTAMPTZ NOT NULL DEFAULT now(), storage_class TEXT NOT NULL DEFAULT 'private_immutable' CHECK(storage_class='private_immutable'),
 object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 byte_size INTEGER NOT NULL CHECK(byte_size>0), content_type TEXT NOT NULL CHECK(content_type='application/pdf'),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), recorded_by UUID NOT NULL REFERENCES users(id), request_hash TEXT NOT NULL,
 UNIQUE(document_id,version)
);
CREATE TABLE provider_catalog_items (
 id UUID PRIMARY KEY, provider_id UUID NOT NULL REFERENCES organizations(id), sku TEXT NOT NULL,
 head_version INTEGER NOT NULL DEFAULT 0, UNIQUE(provider_id,sku)
);
CREATE TABLE provider_catalog_versions (
 id UUID PRIMARY KEY, item_id UUID NOT NULL REFERENCES provider_catalog_items(id), version INTEGER NOT NULL,
 payload JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), recorded_by UUID NOT NULL REFERENCES users(id), request_hash TEXT NOT NULL,
 UNIQUE(item_id,version)
);
CREATE TABLE replacement_estimates (
 id UUID PRIMARY KEY, provider_id UUID NOT NULL REFERENCES organizations(id), opening_id UUID NOT NULL REFERENCES openings(id),
 head_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE replacement_estimate_versions (
 id UUID PRIMARY KEY, estimate_id UUID NOT NULL REFERENCES replacement_estimates(id), version INTEGER NOT NULL,
 snapshot JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), recorded_by UUID NOT NULL REFERENCES users(id), request_hash TEXT NOT NULL,
 UNIQUE(estimate_id,version)
);
CREATE TABLE commercial_document_links (
 document_version_id UUID NOT NULL REFERENCES commercial_document_versions(id),
 estimate_version_id UUID REFERENCES replacement_estimate_versions(id), lifecycle_record_id UUID REFERENCES lifecycle_records(id),
 CHECK((estimate_version_id IS NOT NULL)::int+(lifecycle_record_id IS NOT NULL)::int=1),
 UNIQUE(document_version_id,estimate_version_id), UNIQUE(document_version_id,lifecycle_record_id)
);
CREATE TABLE estimate_reviews (
 id UUID PRIMARY KEY, estimate_version_id UUID NOT NULL REFERENCES replacement_estimate_versions(id),
 reviewed_by UUID NOT NULL REFERENCES users(id), reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 opening_revision BIGINT NOT NULL, note TEXT NOT NULL, request_hash TEXT NOT NULL
);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['commercial_document_versions','provider_catalog_versions','replacement_estimate_versions','commercial_document_links','estimate_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_installation_history()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['commercial_documents','commercial_document_versions','provider_catalog_items','provider_catalog_versions','replacement_estimates','replacement_estimate_versions','commercial_document_links','estimate_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
   EXECUTE format('GRANT SELECT,INSERT ON %I TO oi_pr2_api',t);
   EXECUTE format('CREATE POLICY server_select ON %I FOR SELECT TO oi_pr2_api USING(true)',t);
   EXECUTE format('CREATE POLICY server_insert ON %I FOR INSERT TO oi_pr2_api WITH CHECK(true)',t);
   IF t IN ('commercial_documents','provider_catalog_items','replacement_estimates') THEN
    EXECUTE format('GRANT UPDATE ON %I TO oi_pr2_api',t);
    EXECUTE format('CREATE POLICY server_update ON %I FOR UPDATE TO oi_pr2_api USING(true) WITH CHECK(true)',t);
   END IF;
  END IF;
 END LOOP;
END $$;
