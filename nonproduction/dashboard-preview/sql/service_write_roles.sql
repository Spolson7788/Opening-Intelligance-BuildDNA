-- Isolated nonproduction preview only. Preserve member read access.
ALTER POLICY oi_ins ON public.service_requests WITH CHECK (public.can_write(facility_id));
ALTER POLICY oi_upd ON public.service_requests USING (public.can_write(facility_id)) WITH CHECK (public.can_write(facility_id));
ALTER POLICY oi_ins ON public.service_events WITH CHECK (public.can_write(facility_id));
ALTER POLICY oi_upd ON public.service_events USING (public.can_write(facility_id)) WITH CHECK (public.can_write(facility_id));
ALTER POLICY oi_ins ON public.deficiencies WITH CHECK (public.can_write(facility_id));
ALTER POLICY oi_upd ON public.deficiencies USING (public.can_write(facility_id)) WITH CHECK (public.can_write(facility_id));
ALTER POLICY oi_ins ON public.service_observations WITH CHECK (EXISTS (SELECT 1 FROM public.service_events e WHERE e.id = service_observations.event_id AND public.can_write(e.facility_id)));
ALTER POLICY oi_ins ON public.service_outcomes WITH CHECK (EXISTS (SELECT 1 FROM public.service_events e WHERE e.id = service_outcomes.event_id AND public.can_write(e.facility_id)));
ALTER POLICY oi_upd ON public.service_outcomes USING (EXISTS (SELECT 1 FROM public.service_events e WHERE e.id = service_outcomes.event_id AND public.can_write(e.facility_id))) WITH CHECK (EXISTS (SELECT 1 FROM public.service_events e WHERE e.id = service_outcomes.event_id AND public.can_write(e.facility_id)));
ALTER POLICY oi_ins ON public.diagnostic_hypotheses WITH CHECK (EXISTS (SELECT 1 FROM public.service_events e WHERE e.id = diagnostic_hypotheses.event_id AND public.can_write(e.facility_id)));
ALTER POLICY oi_upd ON public.diagnostic_hypotheses USING (EXISTS (SELECT 1 FROM public.service_events e WHERE e.id = diagnostic_hypotheses.event_id AND public.can_write(e.facility_id))) WITH CHECK (EXISTS (SELECT 1 FROM public.service_events e WHERE e.id = diagnostic_hypotheses.event_id AND public.can_write(e.facility_id)));
ALTER POLICY oi_ins ON public.verification_events WITH CHECK (EXISTS (SELECT 1 FROM public.deficiencies d WHERE d.id = verification_events.deficiency_id AND public.can_write(d.facility_id)));
ALTER POLICY oi_upd ON public.verification_events USING (EXISTS (SELECT 1 FROM public.deficiencies d WHERE d.id = verification_events.deficiency_id AND public.can_write(d.facility_id))) WITH CHECK (EXISTS (SELECT 1 FROM public.deficiencies d WHERE d.id = verification_events.deficiency_id AND public.can_write(d.facility_id)));
