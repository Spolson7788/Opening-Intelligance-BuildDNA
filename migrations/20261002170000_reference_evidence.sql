-- Shared manufacturer knowledge. Tenant administrators cannot approve it.
CREATE TABLE reference_approvers (
 user_id UUID PRIMARY KEY REFERENCES users(id), granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE reference_documents (
 sha256 TEXT PRIMARY KEY CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 manufacturer TEXT NOT NULL, brand TEXT NOT NULL, title TEXT NOT NULL,
 doc_type TEXT NOT NULL, page_count INTEGER NOT NULL CHECK(page_count>0),
 storage_key TEXT NOT NULL, metadata JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded','duplicate')),
 superseded_by TEXT REFERENCES reference_documents(sha256) DEFERRABLE INITIALLY DEFERRED,
 duplicate_of TEXT REFERENCES reference_documents(sha256) DEFERRABLE INITIALLY DEFERRED,
 approved_by UUID REFERENCES users(id), approved_at TIMESTAMPTZ,
 CHECK(status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
 CHECK(status <> 'superseded' OR superseded_by IS NOT NULL),
 CHECK(status <> 'duplicate' OR duplicate_of IS NOT NULL)
);
CREATE TABLE reference_pages (
 doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256), page_no INTEGER NOT NULL CHECK(page_no>0),
 page_id TEXT GENERATED ALWAYS AS ('sha256:' || doc_sha256 || '#p' || page_no::text) STORED,
 text TEXT NOT NULL, text_sha256 TEXT NOT NULL CHECK(text_sha256 ~ '^[0-9a-f]{64}$'),
 page_class TEXT NOT NULL CHECK(page_class IN ('text','drawing','scan','photo','blank','mixed')),
 transcription_status TEXT NOT NULL CHECK(transcription_status IN ('none','queued','transcribed','verified')),
 citable BOOLEAN NOT NULL, fraction_unverified BOOLEAN NOT NULL DEFAULT false,
 image_key TEXT, image_sha256 TEXT CHECK(image_sha256 IS NULL OR image_sha256 ~ '^[a-f0-9]{64}$'),
 search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',text)) STORED,
 PRIMARY KEY(doc_sha256,page_no), UNIQUE(page_id),
 CHECK(NOT citable OR (page_class <> 'blank' AND NOT fraction_unverified
   AND (page_class NOT IN ('scan','drawing','mixed') OR transcription_status='verified')))
);
CREATE INDEX reference_page_search ON reference_pages USING GIN(search_vector);
CREATE TABLE reference_document_models (
 doc_sha256 TEXT NOT NULL, model TEXT NOT NULL, series TEXT, variant TEXT,
 evidence_page INTEGER NOT NULL, evidence_quote TEXT NOT NULL,
 PRIMARY KEY(doc_sha256,model),
 FOREIGN KEY(doc_sha256,evidence_page) REFERENCES reference_pages(doc_sha256,page_no)
);
CREATE INDEX reference_model_lookup ON reference_document_models(lower(model));
CREATE TABLE reference_conflicts (
 doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256), field TEXT NOT NULL,
 values JSONB NOT NULL CHECK(jsonb_typeof(values)='array' AND jsonb_array_length(values)>1),
 PRIMARY KEY(doc_sha256,field)
);
CREATE TABLE recognition_runs (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), organization_id UUID NOT NULL REFERENCES organizations(id),
 opening_id UUID NOT NULL REFERENCES openings(id), user_id UUID NOT NULL REFERENCES users(id),
 component_id UUID REFERENCES hardware_components(id), photo_hashes JSONB NOT NULL,
 technician_attributes JSONB NOT NULL, component_type TEXT NOT NULL, raw_class_code TEXT,
 stage_one JSONB NOT NULL, suggestion JSONB NOT NULL, retrieved_pages JSONB NOT NULL, stage_two JSONB,
 citations JSONB NOT NULL, rejected_citations JSONB NOT NULL, conflicts JSONB NOT NULL,
 status TEXT NOT NULL, model_id TEXT NOT NULL, prompt_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recognition_opening_runs ON recognition_runs(opening_id,created_at DESC);
-- Distinct capabilities: importing cannot approve or alter approved evidence.
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['reference_approvers','reference_documents','reference_pages','reference_document_models','reference_conflicts','recognition_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
   EXECUTE format('GRANT SELECT ON %I TO oi_pr2_api',t);
   EXECUTE format('CREATE POLICY api_read ON %I FOR SELECT TO oi_pr2_api USING(true)',t);
  END IF;
  IF t IN ('reference_documents','reference_pages','reference_document_models','reference_conflicts') THEN
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_reference_editor') THEN
    EXECUTE format('GRANT SELECT ON %I TO oi_reference_editor',t);
    EXECUTE format('CREATE POLICY importer_read ON %I FOR SELECT TO oi_reference_editor USING(true)',t);
    EXECUTE format('GRANT INSERT ON %I TO oi_reference_editor',t);
    IF t='reference_documents' THEN
     EXECUTE 'CREATE POLICY importer_insert ON reference_documents FOR INSERT TO oi_reference_editor WITH CHECK(status IN (''draft'',''superseded'',''duplicate'') AND approved_by IS NULL AND approved_at IS NULL)';
     GRANT UPDATE(status,superseded_by,duplicate_of) ON reference_documents TO oi_reference_editor;
     CREATE POLICY importer_update ON reference_documents FOR UPDATE TO oi_reference_editor
       USING(status IN ('draft','superseded','duplicate'))
       WITH CHECK(status IN ('draft','superseded','duplicate') AND approved_by IS NULL AND approved_at IS NULL);
    ELSE
     EXECUTE format('CREATE POLICY importer_insert ON %I FOR INSERT TO oi_reference_editor WITH CHECK(EXISTS(SELECT 1 FROM reference_documents d WHERE d.sha256=doc_sha256 AND d.status IN (''draft'',''superseded'',''duplicate'')))',t);
    END IF;
   END IF;
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_reference_approver') THEN
    EXECUTE format('GRANT SELECT ON %I TO oi_reference_approver',t);
    EXECUTE format('CREATE POLICY approver_read ON %I FOR SELECT TO oi_reference_approver USING(true)',t);
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT INSERT,UPDATE ON recognition_runs TO oi_pr2_api;
  CREATE POLICY api_insert ON recognition_runs FOR INSERT TO oi_pr2_api WITH CHECK(true);
  CREATE POLICY api_update ON recognition_runs FOR UPDATE TO oi_pr2_api USING(true) WITH CHECK(true);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_reference_approver') THEN
  GRANT UPDATE(status,approved_by,approved_at) ON reference_documents TO oi_reference_approver;
  CREATE POLICY approver_update ON reference_documents FOR UPDATE TO oi_reference_approver
   USING(status IN ('draft','approved'))
   WITH CHECK(status='draft' OR (status='approved' AND EXISTS(
    SELECT 1 FROM reference_approvers a JOIN users u ON u.id=a.user_id WHERE a.user_id=approved_by AND u.is_active)));
  GRANT SELECT ON reference_approvers,users TO oi_reference_approver;
  -- PostgreSQL row locks require UPDATE privilege; policies prohibit mutations.
  GRANT UPDATE(user_id) ON reference_approvers TO oi_reference_approver;
  GRANT UPDATE(id) ON users TO oi_reference_approver;
  GRANT INSERT ON audit_log TO oi_reference_approver;
  CREATE POLICY approver_membership_read ON reference_approvers FOR SELECT TO oi_reference_approver USING(true);
  CREATE POLICY approver_user_read ON users FOR SELECT TO oi_reference_approver
    USING(EXISTS(SELECT 1 FROM reference_approvers a WHERE a.user_id=users.id));
  CREATE POLICY approver_membership_lock ON reference_approvers FOR UPDATE TO oi_reference_approver USING(true) WITH CHECK(false);
  CREATE POLICY approver_user_lock ON users FOR UPDATE TO oi_reference_approver
    USING(EXISTS(SELECT 1 FROM reference_approvers a WHERE a.user_id=users.id)) WITH CHECK(false);
  CREATE POLICY approver_audit ON audit_log FOR INSERT TO oi_reference_approver
    WITH CHECK(EXISTS(SELECT 1 FROM reference_approvers a JOIN users u ON u.id=a.user_id
      WHERE u.id=audit_log.user_id AND u.organization_id=audit_log.organization_id AND u.is_active));
 END IF;
END $$;
