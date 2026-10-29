-- Reference library in the app schema (Stephan approved the milestone 2026-10-29 14:57 MST, card pt150u).
-- DRAFT: not applied anywhere. Ports the opening-intelligence-staging (ioqfdcehnhnqpnqawwvo) library
-- (reference_documents / _document_models / _pages / _conflicts, same column names and types) and adds:
--   * revision + source origin + received date per document,
--   * licence/permission per use: storage, AI processing, customer display,
--   * structured product dimensions with units, endpoints, orientation, configuration, tolerance,
--     source page and verification status,
--   * look-alike (hard-negative) groups,
--   * versioned, immutable reference releases; recognition reads only the single active release.
-- Everything imports as draft. Only OI staff approve or publish, through SECURITY DEFINER functions
-- that re-check staff, require a reason and write platform_audit_events in the same transaction.
-- RLS on every table; anon/authenticated revoked (lesson from 090900); oi_pr2_api read-only.
-- Storage keys must be private object keys (never URLs); the bucket itself stays private.

CREATE TABLE IF NOT EXISTS reference_documents (
  sha256 TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  manufacturer TEXT NOT NULL CHECK (length(btrim(manufacturer)) > 0),
  brand TEXT NOT NULL,
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count >= 0),
  storage_key TEXT NOT NULL CHECK (storage_key !~* '^(https?:|//)' AND storage_key !~* '(^|/)public/'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded','duplicate','rejected')),
  superseded_by TEXT REFERENCES reference_documents(sha256),
  duplicate_of TEXT REFERENCES reference_documents(sha256),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  -- additions
  revision TEXT NOT NULL DEFAULT 'unknown' CHECK (length(btrim(revision)) > 0),
  source_origin TEXT,                       -- manufacturer URL or PC path + package name
  received_on DATE,
  licence_storage TEXT NOT NULL DEFAULT 'unknown' CHECK (licence_storage IN ('unknown','permitted','restricted','denied')),
  licence_ai_processing TEXT NOT NULL DEFAULT 'unknown' CHECK (licence_ai_processing IN ('unknown','permitted','restricted','denied')),
  licence_customer_display TEXT NOT NULL DEFAULT 'unknown' CHECK (licence_customer_display IN ('unknown','permitted','restricted','denied')),
  licence_note TEXT,
  interim_only BOOLEAN NOT NULL DEFAULT false,
  imported_from TEXT,                        -- e.g. 'ioqfdcehnhnqpnqawwvo', 'pc:registry_v17'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reference_documents_approval_complete CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status IN ('superseded')),
  CONSTRAINT reference_documents_approved_needs_ai_licence CHECK (status <> 'approved' OR (licence_ai_processing = 'permitted' AND licence_storage = 'permitted' AND NOT interim_only))
);

CREATE TABLE IF NOT EXISTS reference_document_models (
  id BIGSERIAL PRIMARY KEY,
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  model TEXT NOT NULL,
  series TEXT,
  variant TEXT,
  evidence_page INTEGER NOT NULL CHECK (evidence_page >= 1),
  evidence_quote TEXT NOT NULL,
  UNIQUE (doc_sha256, model, evidence_page)
);

CREATE TABLE IF NOT EXISTS reference_pages (
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  page_no INTEGER NOT NULL CHECK (page_no >= 1),
  page_id TEXT,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  page_class TEXT NOT NULL,
  transcription_status TEXT NOT NULL,
  citable BOOLEAN NOT NULL,
  fraction_unverified BOOLEAN NOT NULL DEFAULT false,
  image_key TEXT CHECK (image_key IS NULL OR image_key !~* '^(https?:|//)'),
  image_sha256 TEXT CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
  search_vector TSVECTOR,
  PRIMARY KEY (doc_sha256, page_no)
);

CREATE TABLE IF NOT EXISTS reference_conflicts (
  id BIGSERIAL PRIMARY KEY,
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  field TEXT NOT NULL,
  "values" JSONB NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false
);

-- Product identities (from the 2,442-row registry and documents). Draft until approved.
CREATE TABLE IF NOT EXISTS reference_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer TEXT NOT NULL CHECK (length(btrim(manufacturer)) > 0),
  brand TEXT,
  component_class TEXT,
  series TEXT,
  model TEXT NOT NULL CHECK (length(btrim(model)) > 0),
  registry_row_ref TEXT,
  spec_sheet_url TEXT,
  cut_sheet_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','superseded')),
  interim_only BOOLEAN NOT NULL DEFAULT false,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  imported_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reference_products_approved_not_interim CHECK (status <> 'approved' OR NOT interim_only),
  CONSTRAINT reference_products_approval_complete CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status = 'superseded')
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_products_identity ON reference_products (lower(manufacturer), lower(model), COALESCE(lower(series), ''));

-- Which document pages support which product.
CREATE TABLE IF NOT EXISTS reference_product_sources (
  product_id UUID NOT NULL REFERENCES reference_products(id),
  doc_sha256 TEXT NOT NULL REFERENCES reference_documents(sha256),
  page_no INTEGER NOT NULL CHECK (page_no >= 1),
  PRIMARY KEY (product_id, doc_sha256, page_no)
);

-- Structured dimensions. A verified dimension always has a value, units, normalized mm and a cited page.
CREATE TABLE IF NOT EXISTS reference_dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES reference_products(id),
  name TEXT NOT NULL,                       -- e.g. 'latch_case_height'
  value NUMERIC,
  units TEXT CHECK (units IS NULL OR units IN ('in','mm','cm','deg','lb','kg')),
  normalized_mm NUMERIC,                    -- lengths normalized to mm (null for non-length units)
  endpoint_a TEXT, endpoint_b TEXT,         -- what the measurement runs between
  orientation TEXT CHECK (orientation IS NULL OR orientation IN ('height','width','depth','projection','diameter','backset','offset','angle','other')),
  configuration TEXT,                       -- e.g. handing, function, option the value applies to
  tolerance TEXT,
  source_doc_sha256 TEXT REFERENCES reference_documents(sha256),
  source_page INTEGER CHECK (source_page IS NULL OR source_page >= 1),
  dimension_source TEXT,                    -- free text from manifests (e.g. source PDF name)
  claim_tier TEXT,                          -- e.g. 'CONFIRMATORY ONLY / NOT IDENTITY'
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','manufacturer_stated','verified','rejected')),
  does_not_establish TEXT,
  imported_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reference_dimensions_verified_complete CHECK (verification_status <> 'verified' OR
    (value IS NOT NULL AND units IS NOT NULL AND source_doc_sha256 IS NOT NULL AND source_page IS NOT NULL
     AND (units NOT IN ('in','mm','cm') OR normalized_mm IS NOT NULL)))
);

-- Look-alike / hard-negative groups (seeded from the Von Duprin hard-negatives set).
CREATE TABLE IF NOT EXISTS reference_lookalike_groups (
  id TEXT PRIMARY KEY,                      -- e.g. 'CS-XM-001'
  name TEXT NOT NULL,
  basis TEXT,
  source_document TEXT,
  source_locator TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  may_support_promotion BOOLEAN NOT NULL DEFAULT false,
  imported_from TEXT
);
CREATE TABLE IF NOT EXISTS reference_lookalike_members (
  group_id TEXT NOT NULL REFERENCES reference_lookalike_groups(id),
  member_key TEXT NOT NULL,                 -- e.g. 'VD-22'
  manufacturer TEXT NOT NULL,
  series_or_model TEXT NOT NULL,
  product_id UUID REFERENCES reference_products(id),
  PRIMARY KEY (group_id, member_key)
);
CREATE TABLE IF NOT EXISTS reference_lookalike_pairs (
  id TEXT PRIMARY KEY,                      -- e.g. 'CF-0001'
  group_id TEXT REFERENCES reference_lookalike_groups(id),
  member_a TEXT NOT NULL, member_b TEXT NOT NULL,
  confusion_basis TEXT, basis_statement TEXT, does_not_establish TEXT,
  document_number TEXT, source_locator TEXT
);

-- Manifest-level assets (image packages; checksums from the package manifests). Never approved by import.
CREATE TABLE IF NOT EXISTS reference_assets (
  id BIGSERIAL PRIMARY KEY,
  package TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  asset_type TEXT,
  byte_size BIGINT,
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  interim_only BOOLEAN NOT NULL DEFAULT false,
  recognition_use_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (package, relative_path)
);

-- Versioned, immutable releases. Items are frozen content hashes; recognition pins to one release.
CREATE TABLE IF NOT EXISTS reference_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','retired')),
  published_by UUID NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_releases_one_active ON reference_releases ((true)) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS reference_release_items (
  release_id UUID NOT NULL REFERENCES reference_releases(id),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('document','page','product','dimension','lookalike_group')),
  item_key TEXT NOT NULL,
  content JSONB NOT NULL,                   -- frozen copy of what recognition may use
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (release_id, item_kind, item_key)
);

CREATE OR REPLACE FUNCTION reference_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'reference_release_items' THEN RAISE EXCEPTION 'reference_release_immutable'; END IF;
  -- Releases: only active -> retired (sets retired_at) is allowed; nothing else changes, never deleted.
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reference_release_immutable'; END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired' AND NEW.retired_at IS NOT NULL
     AND (NEW.id, NEW.version, NEW.published_by, NEW.published_at, NEW.reason, NEW.item_count, NEW.content_sha256)
       IS NOT DISTINCT FROM (OLD.id, OLD.version, OLD.published_by, OLD.published_at, OLD.reason, OLD.item_count, OLD.content_sha256)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'reference_release_immutable';
END $$;
DROP TRIGGER IF EXISTS reference_release_items_immutable ON reference_release_items;
CREATE TRIGGER reference_release_items_immutable BEFORE UPDATE OR DELETE ON reference_release_items
  FOR EACH ROW EXECUTE FUNCTION reference_release_immutable();
DROP TRIGGER IF EXISTS reference_releases_immutable ON reference_releases;
CREATE TRIGGER reference_releases_immutable BEFORE UPDATE OR DELETE ON reference_releases
  FOR EACH ROW EXECUTE FUNCTION reference_release_immutable();

-- Approved documents keep their content: only the status may move to superseded/duplicate.
CREATE OR REPLACE FUNCTION reference_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN RAISE EXCEPTION 'reference_document_approved_immutable'; END IF; RETURN OLD; END IF;
  IF OLD.status = 'approved' AND (NEW.sha256, NEW.manufacturer, NEW.brand, NEW.title, NEW.doc_type, NEW.page_count, NEW.storage_key, NEW.revision)
     IS DISTINCT FROM (OLD.sha256, OLD.manufacturer, OLD.brand, OLD.title, OLD.doc_type, OLD.page_count, OLD.storage_key, OLD.revision)
  THEN RAISE EXCEPTION 'reference_document_approved_immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reference_documents_guard ON reference_documents;
CREATE TRIGGER reference_documents_guard BEFORE UPDATE OR DELETE ON reference_documents
  FOR EACH ROW EXECUTE FUNCTION reference_documents_guard();

-- Recognition runs record which release they used and what they cited.
ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS reference_release_id UUID REFERENCES reference_releases(id);
ALTER TABLE recognition_runs ADD COLUMN IF NOT EXISTS reference_citations JSONB NOT NULL DEFAULT '{"cited":[],"rejected":[]}'::jsonb
  CHECK (jsonb_typeof(reference_citations) = 'object');

-- Audit actions.
ALTER TABLE platform_audit_events DROP CONSTRAINT IF EXISTS platform_audit_events_action_check;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action_check CHECK (action IN (
    'org_created','first_admin_invited','facility_created',
    'staff_granted','staff_revoked',
    'user_deactivated','user_reactivated','user_role_changed',
    'provider_assignment_requested','provider_assignment_request_approved',
    'provider_assignment_request_declined','provider_assignment_request_withdrawn',
    'provider_assignment_set','provider_assignment_revoked',
    'org_parent_changed','membership_added','membership_removed',
    'usage_settings_changed','safety_cap_set','safety_cap_removed',
    'reference_document_approved','reference_product_approved','reference_dimension_verified','reference_lookalike_group_approved','reference_release_published'));

-- Staff-only approval. p_kind: 'document' (key = sha256), 'product' (key = uuid), 'dimension' (key = uuid), 'lookalike_group' (key = id).
CREATE OR REPLACE FUNCTION reference_approve(p_actor UUID, p_actor_org UUID, p_kind TEXT, p_key TEXT, p_reason TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor_org UUID; before jsonb; act TEXT;
BEGIN
  IF p_actor IS NULL OR NOT is_platform_staff(p_actor) THEN RAISE EXCEPTION 'reference_requires_oi_staff'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'reference_reason_required'; END IF;
  IF p_kind = 'document' THEN
    SELECT to_jsonb(d) - 'metadata' INTO before FROM reference_documents d WHERE sha256 = p_key FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF before->>'status' <> 'draft' THEN RAISE EXCEPTION 'reference_not_draft'; END IF;
    UPDATE reference_documents SET status = 'approved', approved_by = p_actor, approved_at = now() WHERE sha256 = p_key;
    act := 'reference_document_approved';
  ELSIF p_kind = 'product' THEN
    SELECT to_jsonb(p) INTO before FROM reference_products p WHERE id = p_key::uuid FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF before->>'status' <> 'draft' THEN RAISE EXCEPTION 'reference_not_draft'; END IF;
    -- A product is approved only with at least one approved, AI-permitted source document page.
    IF NOT EXISTS (SELECT 1 FROM reference_product_sources s JOIN reference_documents d ON d.sha256 = s.doc_sha256
                   WHERE s.product_id = p_key::uuid AND d.status = 'approved') THEN RAISE EXCEPTION 'reference_product_needs_approved_source'; END IF;
    UPDATE reference_products SET status = 'approved', approved_by = p_actor, approved_at = now() WHERE id = p_key::uuid;
    act := 'reference_product_approved';
  ELSIF p_kind = 'dimension' THEN
    SELECT to_jsonb(x) INTO before FROM reference_dimensions x WHERE id = p_key::uuid FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF NOT EXISTS (SELECT 1 FROM reference_documents d WHERE d.sha256 = before->>'source_doc_sha256' AND d.status = 'approved')
      THEN RAISE EXCEPTION 'reference_dimension_needs_approved_source'; END IF;
    UPDATE reference_dimensions SET verification_status = 'verified' WHERE id = p_key::uuid;
    act := 'reference_dimension_verified';
  ELSIF p_kind = 'lookalike_group' THEN
    SELECT to_jsonb(g) INTO before FROM reference_lookalike_groups g WHERE id = p_key FOR UPDATE;
    IF before IS NULL THEN RAISE EXCEPTION 'reference_not_found'; END IF;
    IF before->>'status' <> 'draft' THEN RAISE EXCEPTION 'reference_not_draft'; END IF;
    UPDATE reference_lookalike_groups SET status = 'approved' WHERE id = p_key;
    act := 'reference_lookalike_group_approved';
  ELSE RAISE EXCEPTION 'reference_invalid_kind'; END IF;
  actor_org := COALESCE(p_actor_org, (SELECT organization_id FROM users WHERE id = p_actor));
  INSERT INTO platform_audit_events(actor_user_id, actor_org_id, action, target_org_id, target_id, reason, before_state, after_state)
  VALUES (p_actor, actor_org, act, NULL, NULL, btrim(p_reason), before, jsonb_build_object('kind', p_kind, 'key', p_key));
  RETURN jsonb_build_object('kind', p_kind, 'key', p_key, 'action', act);
END $$;

-- Staff-only publish: freezes every approved document/page/product/verified dimension/approved group
-- into a new version, activates it and retires the previous one. Nothing in a release can change later.
CREATE OR REPLACE FUNCTION reference_release_publish(p_actor UUID, p_actor_org UUID, p_reason TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rid UUID := gen_random_uuid(); v INTEGER; n INTEGER; h TEXT; prev UUID; actor_org UUID;
BEGIN
  IF p_actor IS NULL OR NOT is_platform_staff(p_actor) THEN RAISE EXCEPTION 'reference_requires_oi_staff'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'reference_reason_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reference_release_publish'));
  SELECT COALESCE(max(version), 0) + 1 INTO v FROM reference_releases;
  CREATE TEMP TABLE _rel_items ON COMMIT DROP AS
    SELECT 'document'::text k, d.sha256 key, jsonb_build_object('sha256', d.sha256, 'manufacturer', d.manufacturer, 'brand', d.brand, 'title', d.title,
      'doc_type', d.doc_type, 'revision', d.revision, 'page_count', d.page_count, 'licence_customer_display', d.licence_customer_display) c
      FROM reference_documents d WHERE d.status = 'approved'
    UNION ALL
    SELECT 'page', p.doc_sha256 || ':' || p.page_no, jsonb_build_object('doc_sha256', p.doc_sha256, 'page_no', p.page_no, 'text_sha256', p.text_sha256,
      'page_class', p.page_class, 'text', left(p.text, 4000))
      FROM reference_pages p JOIN reference_documents d ON d.sha256 = p.doc_sha256 WHERE d.status = 'approved' AND p.citable AND NOT p.fraction_unverified
    UNION ALL
    SELECT 'product', pr.id::text, jsonb_build_object('id', pr.id, 'manufacturer', pr.manufacturer, 'brand', pr.brand, 'component_class', pr.component_class,
      'series', pr.series, 'model', pr.model,
      'sources', (SELECT COALESCE(jsonb_agg(jsonb_build_object('doc_sha256', s.doc_sha256, 'page_no', s.page_no) ORDER BY s.doc_sha256, s.page_no), '[]'::jsonb)
                  FROM reference_product_sources s JOIN reference_documents d ON d.sha256 = s.doc_sha256 WHERE s.product_id = pr.id AND d.status = 'approved'))
      FROM reference_products pr WHERE pr.status = 'approved'
    UNION ALL
    SELECT 'dimension', x.id::text, jsonb_build_object('id', x.id, 'product_id', x.product_id, 'name', x.name, 'value', x.value, 'units', x.units,
      'normalized_mm', x.normalized_mm, 'endpoint_a', x.endpoint_a, 'endpoint_b', x.endpoint_b, 'orientation', x.orientation,
      'configuration', x.configuration, 'tolerance', x.tolerance, 'source_doc_sha256', x.source_doc_sha256, 'source_page', x.source_page)
      FROM reference_dimensions x JOIN reference_products pr ON pr.id = x.product_id
      WHERE x.verification_status = 'verified' AND pr.status = 'approved'
    UNION ALL
    SELECT 'lookalike_group', g.id, jsonb_build_object('id', g.id, 'name', g.name, 'basis', g.basis,
      'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', m.member_key, 'manufacturer', m.manufacturer, 'series_or_model', m.series_or_model) ORDER BY m.member_key), '[]'::jsonb)
                  FROM reference_lookalike_members m WHERE m.group_id = g.id))
      FROM reference_lookalike_groups g WHERE g.status = 'approved';
  SELECT count(*), encode(sha256(convert_to(COALESCE(string_agg(k || '|' || key || '|' || c::text, E'\n' ORDER BY k, key), ''), 'UTF8')), 'hex')
    INTO n, h FROM _rel_items;
  SELECT id INTO prev FROM reference_releases WHERE status = 'active' FOR UPDATE;
  IF prev IS NOT NULL THEN UPDATE reference_releases SET status = 'retired', retired_at = now() WHERE id = prev; END IF;
  INSERT INTO reference_releases(id, version, status, published_by, reason, item_count, content_sha256)
    VALUES (rid, v, 'active', p_actor, btrim(p_reason), n, h);
  INSERT INTO reference_release_items(release_id, item_kind, item_key, content, content_sha256)
    SELECT rid, k, key, c, encode(sha256(convert_to(c::text, 'UTF8')), 'hex') FROM _rel_items;
  actor_org := COALESCE(p_actor_org, (SELECT organization_id FROM users WHERE id = p_actor));
  INSERT INTO platform_audit_events(actor_user_id, actor_org_id, action, target_id, reason, before_state, after_state)
  VALUES (p_actor, actor_org, 'reference_release_published', rid, btrim(p_reason),
    jsonb_build_object('previous_release_id', prev), jsonb_build_object('release_id', rid, 'version', v, 'item_count', n, 'content_sha256', h));
  RETURN jsonb_build_object('release_id', rid, 'version', v, 'item_count', n, 'content_sha256', h, 'previous_release_id', prev);
END $$;

-- RLS on, no policies for anon/authenticated; API role reads only.
DO $$ DECLARE t text; roles text; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon','authenticated');
  FOREACH t IN ARRAY ARRAY['reference_documents','reference_document_models','reference_pages','reference_conflicts','reference_products',
    'reference_product_sources','reference_dimensions','reference_lookalike_groups','reference_lookalike_members','reference_lookalike_pairs',
    'reference_assets','reference_releases','reference_release_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %I FROM %s', t, roles); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
      EXECUTE format('GRANT SELECT ON %I TO oi_pr2_api', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_api_read', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO oi_pr2_api USING (true)', t || '_api_read', t);
    END IF;
  END LOOP;
END $$;
DO $$ DECLARE r record; roles text; BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO roles FROM pg_roles WHERE rolname IN ('anon','authenticated');
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'reference\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.f);
    IF roles IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.f, roles); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT EXECUTE ON FUNCTION reference_approve(UUID, UUID, TEXT, TEXT, TEXT) TO oi_pr2_api;
    GRANT EXECUTE ON FUNCTION reference_release_publish(UUID, UUID, TEXT) TO oi_pr2_api;
  END IF;
END $$;
