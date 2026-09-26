SET search_path=public,extensions;
CREATE TYPE public."member_role" AS ENUM ('admin','tech','viewer');
CREATE TYPE public."oi_deficiency_state" AS ENUM ('OPEN','CORRECTIVE_ACTION_ASSIGNED','REPAIR_COMPLETE_VERIFICATION_PENDING','VERIFIED_CLOSED','EXCEPTION_GRANTED');
CREATE TYPE public."oi_eligibility_state" AS ENUM ('ELIGIBLE','NOT_ELIGIBLE','QUALIFICATION_UNRESOLVED','REQUIRED_CREDENTIAL_MISSING','CREDENTIAL_EXPIRED','SCOPE_MISMATCH','ROLE_NOT_PERMITTED','EVIDENCE_MISSING','EVALUATION_PENDING');
CREATE TYPE public."oi_evidence_state" AS ENUM ('VERIFIED','LIKELY','CANDIDATE','UNRESOLVED');
CREATE TYPE public."oi_first_trip" AS ENUM ('YES','RETURN_VISIT_REQUIRED','UNDETERMINED');
CREATE TYPE public."oi_hypothesis_status" AS ENUM ('FIELD_VERIFICATION_REQUIRED','CONFIRMED','ELIMINATED');
CREATE TABLE public."facilities" (id uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL, address text, created_at timestamp with time zone NOT NULL DEFAULT now(), facility_type text, created_by uuid DEFAULT auth.uid());
ALTER TABLE public."facilities" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."memberships" (user_id uuid NOT NULL, facility_id uuid NOT NULL, role member_role NOT NULL DEFAULT 'viewer'::member_role);
ALTER TABLE public."memberships" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."opening_photos" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid NOT NULL, opening_no text NOT NULL, storage_path text NOT NULL, taken_at timestamp with time zone NOT NULL DEFAULT now(), taken_by uuid DEFAULT auth.uid());
ALTER TABLE public."opening_photos" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."openings" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid NOT NULL, opening_no text NOT NULL, area text, component_class text, manufacturer text, model text, fire_rated boolean NOT NULL DEFAULT false, condition text NOT NULL DEFAULT 'unverified'::text, notes text, latest_photo_path text, verified_at timestamp with time zone, health_score integer, health_band text, updated_at timestamp with time zone NOT NULL DEFAULT now(), created_by uuid DEFAULT auth.uid(), repair_cost numeric, work_completed_at date, health_calculation_id uuid);
ALTER TABLE public."openings" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."scans" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid, opening_no text, component_class text, predicted_manufacturer text, predicted_model text, confidence numeric, needs_review boolean, true_model text, correct boolean, attributes jsonb, scanned_at timestamp with time zone NOT NULL DEFAULT now(), scanned_by uuid DEFAULT auth.uid());
ALTER TABLE public."scans" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."inspections" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid, opening_no text NOT NULL, inspected_at date NOT NULL DEFAULT CURRENT_DATE, inspector text, result text, standard text DEFAULT 'NFPA 80'::text, items jsonb, clearances jsonb, deficiencies jsonb, notes text, created_at timestamp with time zone DEFAULT now());
ALTER TABLE public."inspections" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."profiles" (id uuid NOT NULL, user_type text NOT NULL DEFAULT 'facility'::text, full_name text, created_at timestamp with time zone DEFAULT now());
ALTER TABLE public."profiles" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."service_requests" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid NOT NULL, opening_no text, symptom text NOT NULL, reported_by text, reported_at timestamp with time zone NOT NULL DEFAULT now(), priority text, sla_target_hours numeric, sla_computable boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'OPEN'::text, created_by uuid DEFAULT auth.uid(), created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."service_requests" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."service_events" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid NOT NULL, opening_no text NOT NULL, request_id uuid, performed_at timestamp with time zone NOT NULL DEFAULT now(), performed_by uuid DEFAULT auth.uid(), work_performed text, parts_used jsonb NOT NULL DEFAULT '[]'::jsonb, cost numeric, cost_evidence text, door_closes boolean, door_latches boolean, device_operates boolean, evidence_captured boolean, notes text, created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."service_events" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."service_observations" (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid NOT NULL, observation text NOT NULL, observed_at timestamp with time zone NOT NULL DEFAULT now(), created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."service_observations" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."diagnostic_hypotheses" (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid NOT NULL, rank integer NOT NULL, cause text NOT NULL, status oi_hypothesis_status NOT NULL DEFAULT 'FIELD_VERIFICATION_REQUIRED'::oi_hypothesis_status, resolved_at timestamp with time zone, created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."diagnostic_hypotheses" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."deficiencies" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid NOT NULL, opening_no text NOT NULL, deficiency_ref text, raised_by_inspection_at timestamp with time zone, criterion text NOT NULL, severity text, state oi_deficiency_state NOT NULL DEFAULT 'OPEN'::oi_deficiency_state, opened_at timestamp with time zone NOT NULL DEFAULT now(), closed_at timestamp with time zone, created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."deficiencies" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."verification_events" (id uuid NOT NULL DEFAULT gen_random_uuid(), deficiency_id uuid NOT NULL, service_event_id uuid, requirement text, rule_version text, verifier_name text, verifier_party_ref text, verifier_organization text, credential_kind text, credential_scope text, credential_valid_to date, independence_required boolean NOT NULL DEFAULT false, independence_satisfied boolean, eligibility_state oi_eligibility_state NOT NULL DEFAULT 'EVALUATION_PENDING'::oi_eligibility_state, eligibility_basis text, evaluated_at timestamp with time zone, verified_at timestamp with time zone, closure_accepted boolean NOT NULL DEFAULT false, created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."verification_events" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."service_outcomes" (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid NOT NULL, first_trip oi_first_trip NOT NULL DEFAULT 'UNDETERMINED'::oi_first_trip, return_reason text, callback_within_30d boolean, preventability text, created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."service_outcomes" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."health_score_models" (id uuid NOT NULL DEFAULT gen_random_uuid(), model_version text NOT NULL, status text NOT NULL DEFAULT 'DRAFT'::text, scale_max integer NOT NULL DEFAULT 100, description text, effective_from timestamp with time zone, superseded_by text, created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."health_score_models" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."health_score_components" (id uuid NOT NULL DEFAULT gen_random_uuid(), model_version text NOT NULL, component_key text NOT NULL, label text NOT NULL, weight numeric NOT NULL, population_basis text NOT NULL, conversion_rule text NOT NULL, sort_order integer NOT NULL DEFAULT 0);
ALTER TABLE public."health_score_components" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."health_score_drivers" (id uuid NOT NULL DEFAULT gen_random_uuid(), model_version text NOT NULL, component_key text NOT NULL, driver_key text NOT NULL, label text NOT NULL, numerator_source text NOT NULL, denominator_source text NOT NULL, within_component_weight numeric NOT NULL, severity_multiplier numeric NOT NULL DEFAULT 1.0, derivation text NOT NULL DEFAULT 'points = (numerator / denominator) * within_component_weight * severity_multiplier * 100'::text);
ALTER TABLE public."health_score_drivers" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."health_score_calculations" (id uuid NOT NULL DEFAULT gen_random_uuid(), facility_id uuid NOT NULL, scope text NOT NULL DEFAULT 'FACILITY'::text, scope_ref text, model_version text NOT NULL, score numeric NOT NULL, scale_max integer NOT NULL DEFAULT 100, calculated_at timestamp with time zone NOT NULL DEFAULT now(), input_snapshot_ref text, evaluated_population integer, data_coverage_pct numeric, coverage_basis text, display_state text NOT NULL DEFAULT 'ILLUSTRATIVE_MODEL'::text, created_at timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."health_score_calculations" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."health_score_component_results" (id uuid NOT NULL DEFAULT gen_random_uuid(), calculation_id uuid NOT NULL, component_key text NOT NULL, component_score numeric NOT NULL, weight numeric NOT NULL, weighted_points numeric NOT NULL, evaluated_population integer);
ALTER TABLE public."health_score_component_results" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."health_score_driver_results" (id uuid NOT NULL DEFAULT gen_random_uuid(), calculation_id uuid NOT NULL, component_key text NOT NULL, driver_key text NOT NULL, numerator numeric NOT NULL, denominator numeric NOT NULL, rate numeric NOT NULL, severity_multiplier numeric NOT NULL, points_withheld numeric NOT NULL);
ALTER TABLE public."health_score_driver_results" ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.compute_health(cond text, fire boolean, photo text, ver timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare s int;
begin
  s := case cond when 'good'   then 100   -- Healthy
                 when 'worn'   then 68     -- Monitor
                 when 'failed' then 30     -- Critical
                 else 65 end;              -- unverified = neutral
  -- fire-rated life-safety overlay (only sharpens worn/failed on a fire door)
  if fire and cond = 'failed' then s := least(s, 20); end if;
  if fire and cond = 'worn'   then s := s - 12;      end if;
  -- photo presence NO LONGER changes the score (tracked separately as coverage)
  return greatest(0, least(100, s));
end $function$
;
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.openings_set_health()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.health_score := compute_health(new.condition, new.fire_rated, new.latest_photo_path, new.verified_at);
  new.health_band  := case when new.health_score >= 80 then 'healthy'
                           when new.health_score >= 60 then 'monitor'
                           when new.health_score >= 40 then 'serious'
                           else 'critical' end;
  new.updated_at := now();
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.is_member(fid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.memberships m
                 where m.facility_id = fid and m.user_id = auth.uid());
$function$
;
CREATE OR REPLACE FUNCTION public.my_type()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select user_type from public.profiles where id = auth.uid();
$function$
;
CREATE OR REPLACE FUNCTION public.can_write(fid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(select 1 from memberships m
                where m.facility_id=fid and m.user_id=auth.uid()
                  and m.role in ('admin','tech'));
$function$
;
CREATE OR REPLACE FUNCTION public.oi_enforce_closure_gate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.closure_accepted and new.eligibility_state <> 'ELIGIBLE' then
    raise exception
      'closure_accepted requires eligibility_state = ELIGIBLE (got %)', new.eligibility_state;
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.oi_is_member(fac uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.memberships m
    where m.facility_id = fac and m.user_id = auth.uid()
  );
$function$
;
CREATE OR REPLACE FUNCTION public.oi_check_model_weights()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare s numeric;
begin
  if new.status = 'ACTIVE' then
    select coalesce(sum(weight),0) into s
      from public.health_score_components where model_version = new.model_version;
    if abs(s - 1) > 0.001 then
      raise exception 'model % cannot be ACTIVE: component weights sum to % (must be 1)',
        new.model_version, s;
    end if;
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.oi_check_calculation_total()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare s numeric; stored numeric;
begin
  select coalesce(sum(weighted_points),0) into s
    from public.health_score_component_results where calculation_id = new.calculation_id;
  select score into stored
    from public.health_score_calculations where id = new.calculation_id;
  if stored is null then return new; end if;          -- calculation deleted in same tx
  if s > 0 and abs(s - stored) > 0.5 then
    raise exception
      'calculation % total (%) does not equal the sum of its components (%)',
      new.calculation_id, stored, s;
  end if;
  return new;
end $function$
;
ALTER TABLE public."facilities" ADD CONSTRAINT "facilities_pkey" PRIMARY KEY (id);
ALTER TABLE public."memberships" ADD CONSTRAINT "memberships_pkey" PRIMARY KEY (user_id, facility_id);
ALTER TABLE public."openings" ADD CONSTRAINT "openings_condition_check" CHECK ((condition = ANY (ARRAY['good'::text, 'worn'::text, 'failed'::text, 'unverified'::text])));
ALTER TABLE public."openings" ADD CONSTRAINT "openings_pkey" PRIMARY KEY (id);
ALTER TABLE public."opening_photos" ADD CONSTRAINT "opening_photos_pkey" PRIMARY KEY (id);
ALTER TABLE public."scans" ADD CONSTRAINT "scans_pkey" PRIMARY KEY (id);
ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_user_type_check" CHECK ((user_type = ANY (ARRAY['vortex'::text, 'facility'::text, 'admin'::text])));
ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (id);
ALTER TABLE public."inspections" ADD CONSTRAINT "inspections_pkey" PRIMARY KEY (id);
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_pkey" PRIMARY KEY (id);
ALTER TABLE public."service_events" ADD CONSTRAINT "service_events_pkey" PRIMARY KEY (id);
ALTER TABLE public."service_observations" ADD CONSTRAINT "service_observations_pkey" PRIMARY KEY (id);
ALTER TABLE public."diagnostic_hypotheses" ADD CONSTRAINT "diagnostic_hypotheses_pkey" PRIMARY KEY (id);
ALTER TABLE public."diagnostic_hypotheses" ADD CONSTRAINT "diagnostic_hypotheses_event_id_rank_key" UNIQUE (event_id, rank);
ALTER TABLE public."deficiencies" ADD CONSTRAINT "deficiencies_pkey" PRIMARY KEY (id);
ALTER TABLE public."verification_events" ADD CONSTRAINT "verification_events_pkey" PRIMARY KEY (id);
ALTER TABLE public."service_outcomes" ADD CONSTRAINT "service_outcomes_pkey" PRIMARY KEY (id);
ALTER TABLE public."service_outcomes" ADD CONSTRAINT "service_outcomes_event_id_key" UNIQUE (event_id);
ALTER TABLE public."health_score_models" ADD CONSTRAINT "health_score_models_pkey" PRIMARY KEY (id);
ALTER TABLE public."health_score_models" ADD CONSTRAINT "health_score_models_model_version_key" UNIQUE (model_version);
ALTER TABLE public."health_score_components" ADD CONSTRAINT "health_score_components_weight_check" CHECK (((weight > (0)::numeric) AND (weight <= (1)::numeric)));
ALTER TABLE public."health_score_components" ADD CONSTRAINT "health_score_components_pkey" PRIMARY KEY (id);
ALTER TABLE public."health_score_components" ADD CONSTRAINT "health_score_components_model_version_component_key_key" UNIQUE (model_version, component_key);
ALTER TABLE public."health_score_drivers" ADD CONSTRAINT "health_score_drivers_within_component_weight_check" CHECK (((within_component_weight > (0)::numeric) AND (within_component_weight <= (1)::numeric)));
ALTER TABLE public."health_score_drivers" ADD CONSTRAINT "health_score_drivers_pkey" PRIMARY KEY (id);
ALTER TABLE public."health_score_drivers" ADD CONSTRAINT "health_score_drivers_model_version_component_key_driver_key_key" UNIQUE (model_version, component_key, driver_key);
ALTER TABLE public."health_score_calculations" ADD CONSTRAINT "health_score_calculations_data_coverage_pct_check" CHECK (((data_coverage_pct >= (0)::numeric) AND (data_coverage_pct <= (100)::numeric)));
ALTER TABLE public."health_score_calculations" ADD CONSTRAINT "health_score_calculations_pkey" PRIMARY KEY (id);
ALTER TABLE public."health_score_component_results" ADD CONSTRAINT "health_score_component_results_pkey" PRIMARY KEY (id);
ALTER TABLE public."health_score_component_results" ADD CONSTRAINT "health_score_component_results_calculation_id_component_key_key" UNIQUE (calculation_id, component_key);
ALTER TABLE public."health_score_driver_results" ADD CONSTRAINT "health_score_driver_results_denominator_check" CHECK ((denominator > (0)::numeric));
ALTER TABLE public."health_score_driver_results" ADD CONSTRAINT "health_score_driver_results_pkey" PRIMARY KEY (id);
ALTER TABLE public."health_score_driver_results" ADD CONSTRAINT "health_score_driver_results_calculation_id_component_key_dr_key" UNIQUE (calculation_id, component_key, driver_key);
ALTER TABLE public."openings" ADD CONSTRAINT "openings_facility_opening_component_key" UNIQUE (facility_id, opening_no, component_class);
ALTER TABLE public."memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."memberships" ADD CONSTRAINT "memberships_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."openings" ADD CONSTRAINT "openings_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."opening_photos" ADD CONSTRAINT "opening_photos_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."scans" ADD CONSTRAINT "scans_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."inspections" ADD CONSTRAINT "inspections_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."service_requests" ADD CONSTRAINT "service_requests_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public."service_events" ADD CONSTRAINT "service_events_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."service_events" ADD CONSTRAINT "service_events_request_id_fkey" FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE SET NULL;
ALTER TABLE public."service_events" ADD CONSTRAINT "service_events_performed_by_fkey" FOREIGN KEY (performed_by) REFERENCES auth.users(id);
ALTER TABLE public."service_observations" ADD CONSTRAINT "service_observations_event_id_fkey" FOREIGN KEY (event_id) REFERENCES service_events(id) ON DELETE CASCADE;
ALTER TABLE public."diagnostic_hypotheses" ADD CONSTRAINT "diagnostic_hypotheses_event_id_fkey" FOREIGN KEY (event_id) REFERENCES service_events(id) ON DELETE CASCADE;
ALTER TABLE public."deficiencies" ADD CONSTRAINT "deficiencies_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."verification_events" ADD CONSTRAINT "verification_events_deficiency_id_fkey" FOREIGN KEY (deficiency_id) REFERENCES deficiencies(id) ON DELETE CASCADE;
ALTER TABLE public."verification_events" ADD CONSTRAINT "verification_events_service_event_id_fkey" FOREIGN KEY (service_event_id) REFERENCES service_events(id) ON DELETE SET NULL;
ALTER TABLE public."service_outcomes" ADD CONSTRAINT "service_outcomes_event_id_fkey" FOREIGN KEY (event_id) REFERENCES service_events(id) ON DELETE CASCADE;
ALTER TABLE public."health_score_components" ADD CONSTRAINT "health_score_components_model_version_fkey" FOREIGN KEY (model_version) REFERENCES health_score_models(model_version) ON DELETE CASCADE;
ALTER TABLE public."health_score_drivers" ADD CONSTRAINT "health_score_drivers_model_version_component_key_fkey" FOREIGN KEY (model_version, component_key) REFERENCES health_score_components(model_version, component_key) ON DELETE CASCADE;
ALTER TABLE public."health_score_calculations" ADD CONSTRAINT "health_score_calculations_facility_id_fkey" FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE;
ALTER TABLE public."health_score_calculations" ADD CONSTRAINT "health_score_calculations_model_version_fkey" FOREIGN KEY (model_version) REFERENCES health_score_models(model_version);
ALTER TABLE public."health_score_component_results" ADD CONSTRAINT "health_score_component_results_calculation_id_fkey" FOREIGN KEY (calculation_id) REFERENCES health_score_calculations(id) ON DELETE CASCADE;
ALTER TABLE public."health_score_driver_results" ADD CONSTRAINT "health_score_driver_results_calculation_id_fkey" FOREIGN KEY (calculation_id) REFERENCES health_score_calculations(id) ON DELETE CASCADE;
ALTER TABLE public."openings" ADD CONSTRAINT "openings_health_calculation_id_fkey" FOREIGN KEY (health_calculation_id) REFERENCES health_score_calculations(id) ON DELETE SET NULL;
CREATE VIEW public."opening_last_inspection" WITH (security_invoker=true) AS  SELECT facility_id,
    opening_no,
    max(inspected_at) AS last_inspected_at
   FROM inspections
  GROUP BY facility_id, opening_no;
CREATE VIEW public."opening_service_summary" WITH (security_invoker=true) AS  SELECT facility_id,
    opening_no,
    count(*) AS events_total,
    count(*) FILTER (WHERE (performed_at > (now() - '90 days'::interval))) AS events_90d,
    count(*) FILTER (WHERE (performed_at > (now() - '3 years'::interval))) AS events_3y,
    sum(cost) FILTER (WHERE (performed_at > (now() - '3 years'::interval))) AS spend_3y,
    max(performed_at) AS last_event_at
   FROM service_events e
  GROUP BY facility_id, opening_no;
CREATE VIEW public."opening_health_provenance" WITH (security_invoker=true) AS  SELECT o.facility_id,
    o.opening_no,
    o.health_score,
    o.health_band,
    c.model_version,
    c.calculated_at,
    c.data_coverage_pct,
    c.display_state,
        CASE
            WHEN (o.health_score IS NULL) THEN 'NO_SCORE'::text
            WHEN (o.health_calculation_id IS NULL) THEN 'UNEXPLAINED_LEGACY_SCORE'::text
            WHEN (c.display_state = 'ILLUSTRATIVE_MODEL'::text) THEN 'ILLUSTRATIVE'::text
            ELSE 'GOVERNED'::text
        END AS provenance_state
   FROM (openings o
     LEFT JOIN health_score_calculations c ON ((c.id = o.health_calculation_id)));
CREATE TRIGGER trg_openings_health BEFORE INSERT OR UPDATE ON public.openings FOR EACH ROW EXECUTE FUNCTION openings_set_health();
CREATE TRIGGER oi_closure_gate BEFORE INSERT OR UPDATE ON public.verification_events FOR EACH ROW EXECUTE FUNCTION oi_enforce_closure_gate();
CREATE TRIGGER oi_model_weights BEFORE INSERT OR UPDATE ON public.health_score_models FOR EACH ROW EXECUTE FUNCTION oi_check_model_weights();
CREATE CONSTRAINT TRIGGER oi_calc_total AFTER INSERT OR UPDATE ON public.health_score_component_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION oi_check_calculation_total();
CREATE POLICY "fac_read" ON "public"."facilities" AS PERMISSIVE FOR SELECT TO authenticated USING (is_member(id));
CREATE POLICY "mem_read" ON "public"."memberships" AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY "opn_read" ON "public"."openings" AS PERMISSIVE FOR SELECT TO authenticated USING (is_member(facility_id));
CREATE POLICY "opn_ins" ON "public"."openings" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (can_write(facility_id));
CREATE POLICY "opn_upd" ON "public"."openings" AS PERMISSIVE FOR UPDATE TO authenticated USING (can_write(facility_id)) WITH CHECK (can_write(facility_id));
CREATE POLICY "ph_read" ON "public"."opening_photos" AS PERMISSIVE FOR SELECT TO authenticated USING (is_member(facility_id));
CREATE POLICY "ph_ins" ON "public"."opening_photos" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (can_write(facility_id));
CREATE POLICY "oi photos read" ON "storage"."objects" AS PERMISSIVE FOR SELECT TO authenticated USING (((bucket_id = 'opening-photos'::text) AND is_member(((storage.foldername(name))[1])::uuid)));
CREATE POLICY "oi photos write" ON "storage"."objects" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'opening-photos'::text) AND can_write(((storage.foldername(name))[1])::uuid)));
CREATE POLICY "scans_read" ON "public"."scans" AS PERMISSIVE FOR SELECT TO authenticated USING (is_member(facility_id));
CREATE POLICY "scans_write" ON "public"."scans" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (can_write(facility_id));
CREATE POLICY "authed can insert facilities" ON "public"."facilities" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "oi_sel" ON "public"."service_events" AS PERMISSIVE FOR SELECT TO authenticated USING (oi_is_member(facility_id));
CREATE POLICY "oi_ins" ON "public"."service_events" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (oi_is_member(facility_id));
CREATE POLICY "oi_upd" ON "public"."service_events" AS PERMISSIVE FOR UPDATE TO authenticated USING (oi_is_member(facility_id)) WITH CHECK (oi_is_member(facility_id));
CREATE POLICY "oi_sel" ON "public"."deficiencies" AS PERMISSIVE FOR SELECT TO authenticated USING (oi_is_member(facility_id));
CREATE POLICY "oi_ins" ON "public"."deficiencies" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (oi_is_member(facility_id));
CREATE POLICY "oi_upd" ON "public"."deficiencies" AS PERMISSIVE FOR UPDATE TO authenticated USING (oi_is_member(facility_id)) WITH CHECK (oi_is_member(facility_id));
CREATE POLICY "member or creator can read facility" ON "public"."facilities" AS PERMISSIVE FOR SELECT TO authenticated USING (((created_by = auth.uid()) OR (id IN ( SELECT memberships.facility_id
   FROM memberships
  WHERE (memberships.user_id = auth.uid())))));
CREATE POLICY "read own profile" ON "public"."profiles" AS PERMISSIVE FOR SELECT TO authenticated USING ((id = auth.uid()));
CREATE POLICY "insert own profile" ON "public"."profiles" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((id = auth.uid()));
CREATE POLICY "update own profile" ON "public"."profiles" AS PERMISSIVE FOR UPDATE TO authenticated USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));
CREATE POLICY "inspections_read" ON "public"."inspections" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.facility_id = inspections.facility_id) AND (m.user_id = auth.uid())))));
CREATE POLICY "inspections_insert" ON "public"."inspections" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.facility_id = inspections.facility_id) AND (m.user_id = auth.uid())))));
CREATE POLICY "oi_sel" ON "public"."service_requests" AS PERMISSIVE FOR SELECT TO authenticated USING (oi_is_member(facility_id));
CREATE POLICY "oi_ins" ON "public"."service_requests" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (oi_is_member(facility_id));
CREATE POLICY "oi_upd" ON "public"."service_requests" AS PERMISSIVE FOR UPDATE TO authenticated USING (oi_is_member(facility_id)) WITH CHECK (oi_is_member(facility_id));
CREATE POLICY "oi_sel" ON "public"."service_observations" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = service_observations.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_ins" ON "public"."service_observations" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = service_observations.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_sel" ON "public"."diagnostic_hypotheses" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = diagnostic_hypotheses.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_ins" ON "public"."diagnostic_hypotheses" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = diagnostic_hypotheses.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_upd" ON "public"."diagnostic_hypotheses" AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = diagnostic_hypotheses.event_id) AND oi_is_member(e.facility_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = diagnostic_hypotheses.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_sel" ON "public"."service_outcomes" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = service_outcomes.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_ins" ON "public"."service_outcomes" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = service_outcomes.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_upd" ON "public"."service_outcomes" AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = service_outcomes.event_id) AND oi_is_member(e.facility_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM service_events e
  WHERE ((e.id = service_outcomes.event_id) AND oi_is_member(e.facility_id)))));
CREATE POLICY "oi_sel" ON "public"."verification_events" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM deficiencies d
  WHERE ((d.id = verification_events.deficiency_id) AND oi_is_member(d.facility_id)))));
CREATE POLICY "oi_ins" ON "public"."verification_events" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM deficiencies d
  WHERE ((d.id = verification_events.deficiency_id) AND oi_is_member(d.facility_id)))));
CREATE POLICY "oi_upd" ON "public"."verification_events" AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM deficiencies d
  WHERE ((d.id = verification_events.deficiency_id) AND oi_is_member(d.facility_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM deficiencies d
  WHERE ((d.id = verification_events.deficiency_id) AND oi_is_member(d.facility_id)))));
CREATE POLICY "oi_sel" ON "public"."health_score_models" AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() IS NOT NULL));
CREATE POLICY "oi_sel" ON "public"."health_score_components" AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() IS NOT NULL));
CREATE POLICY "oi_sel" ON "public"."health_score_drivers" AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() IS NOT NULL));
CREATE POLICY "oi_sel" ON "public"."health_score_calculations" AS PERMISSIVE FOR SELECT TO authenticated USING (oi_is_member(facility_id));
CREATE POLICY "oi_ins" ON "public"."health_score_calculations" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (oi_is_member(facility_id));
CREATE POLICY "oi_sel" ON "public"."health_score_component_results" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM health_score_calculations c
  WHERE ((c.id = health_score_component_results.calculation_id) AND oi_is_member(c.facility_id)))));
CREATE POLICY "oi_ins" ON "public"."health_score_component_results" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM health_score_calculations c
  WHERE ((c.id = health_score_component_results.calculation_id) AND oi_is_member(c.facility_id)))));
CREATE POLICY "oi_sel" ON "public"."health_score_driver_results" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM health_score_calculations c
  WHERE ((c.id = health_score_driver_results.calculation_id) AND oi_is_member(c.facility_id)))));
CREATE POLICY "oi_ins" ON "public"."health_score_driver_results" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM health_score_calculations c
  WHERE ((c.id = health_score_driver_results.calculation_id) AND oi_is_member(c.facility_id)))));
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_member(uuid),public.can_write(uuid),public.my_type(),public.oi_is_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_health(text,boolean,text,timestamptz) TO authenticated;
