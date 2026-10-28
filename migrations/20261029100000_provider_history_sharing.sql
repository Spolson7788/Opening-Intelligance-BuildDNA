-- t97 item 2: per-facility setting for whether assigned service providers can see each
-- other's service history. Default OFF: each provider sees only its own service events
-- (and photos attached to them); the owning organization always sees everything.
-- Only the facility owner's administrator can change it (PUT /api/portfolio/properties/:id/provider-history-sharing).
-- Additive and backward compatible: existing rows get false. No data is rewritten.
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS share_provider_service_history boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.properties.share_provider_service_history IS
  'When true, organizations with an active facility_provider_assignments row may see service events recorded by other organizations at this facility. Owner always sees all.';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
    GRANT SELECT (share_provider_service_history), UPDATE (share_provider_service_history) ON public.properties TO oi_pr2_api;
  END IF;
END $$;
