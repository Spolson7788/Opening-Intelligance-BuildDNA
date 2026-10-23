-- Request intent is separate from performed service, condition and procurement.
-- Created with the CLI; only applied to disposable local databases in this task.
CREATE TABLE service_requests (
 id UUID PRIMARY KEY,
 opening_id UUID NOT NULL REFERENCES openings(id),
 requesting_organization_id UUID NOT NULL REFERENCES organizations(id),
 created_by_user_id UUID NOT NULL REFERENCES users(id),
 provider_organization_id UUID NOT NULL REFERENCES organizations(id),
 symptom TEXT NOT NULL CHECK(length(trim(symptom)) BETWEEN 1 AND 4000),
 impact TEXT NOT NULL CHECK(length(impact)<=2000),
 priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
 uncertain_target BOOLEAN NOT NULL,
 status TEXT NOT NULL DEFAULT 'submitted' CHECK(status='submitted'),
 notification_status TEXT NOT NULL DEFAULT 'disabled' CHECK(notification_status='disabled'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,opening_id)
);
CREATE INDEX service_requests_opening ON service_requests(opening_id,created_at);
CREATE UNIQUE INDEX opening_frames_id_opening ON opening_frames(id,opening_id);
CREATE UNIQUE INDEX door_leaves_id_opening ON door_leaves(id,opening_id);
CREATE UNIQUE INDEX hardware_components_id_opening ON hardware_components(id,opening_id);
CREATE UNIQUE INDEX photos_id_opening ON photos(id,opening_id);
CREATE TABLE service_request_targets (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 request_id UUID NOT NULL,
 opening_id UUID NOT NULL,
 frame_id UUID,
 door_leaf_id UUID,
 hardware_component_id UUID,
 CHECK(num_nonnulls(frame_id,door_leaf_id,hardware_component_id)=1),
 FOREIGN KEY(request_id,opening_id) REFERENCES service_requests(id,opening_id),
 FOREIGN KEY(frame_id,opening_id) REFERENCES opening_frames(id,opening_id),
 FOREIGN KEY(door_leaf_id,opening_id) REFERENCES door_leaves(id,opening_id),
 FOREIGN KEY(hardware_component_id,opening_id) REFERENCES hardware_components(id,opening_id)
);
CREATE INDEX service_request_targets_request ON service_request_targets(request_id);
CREATE TABLE service_request_photos (
 request_id UUID NOT NULL,
 opening_id UUID NOT NULL,
 photo_id UUID NOT NULL,
 PRIMARY KEY(request_id,photo_id),
 FOREIGN KEY(request_id,opening_id) REFERENCES service_requests(id,opening_id),
 FOREIGN KEY(photo_id,opening_id) REFERENCES photos(id,opening_id) ON DELETE CASCADE
);
ALTER TABLE sync_operation_receipts DROP CONSTRAINT sync_operation_receipts_entity_type_check;
ALTER TABLE sync_operation_receipts ADD CONSTRAINT sync_operation_receipts_entity_type_check
 CHECK(entity_type IN ('opening','frame','door_leaf','component','photo','service_event','inspection_event','completion','purchasing_review','service_request'));
ALTER TABLE service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request_photos ENABLE ROW LEVEL SECURITY;
-- Existing server-role model: no browser Data API grants or policies.
REVOKE ALL ON service_requests,service_request_targets,service_request_photos FROM PUBLIC;
DO $$ DECLARE t TEXT; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON service_requests,service_request_targets,service_request_photos FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON service_requests,service_request_targets,service_request_photos FROM authenticated;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT,INSERT ON service_requests,service_request_targets,service_request_photos TO oi_pr2_api;
  FOREACH t IN ARRAY ARRAY['service_requests','service_request_targets','service_request_photos'] LOOP
   EXECUTE format('CREATE POLICY oi_pr2_api_select ON public.%I FOR SELECT TO oi_pr2_api USING(true)',t);
   EXECUTE format('CREATE POLICY oi_pr2_api_insert ON public.%I FOR INSERT TO oi_pr2_api WITH CHECK(true)',t);
  END LOOP;
 END IF;
END $$;
