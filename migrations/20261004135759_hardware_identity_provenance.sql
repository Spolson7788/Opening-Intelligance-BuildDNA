-- Existing records retain unknown provenance; never infer their source retrospectively.
ALTER TABLE public.hardware_components
 ADD COLUMN identity_source TEXT NOT NULL DEFAULT 'unknown'
   CHECK(identity_source IN ('unknown','technician_identified','photo_suggestion')),
 ADD COLUMN identity_acknowledged_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
 ADD COLUMN identity_acknowledged_at TIMESTAMPTZ,
 ADD COLUMN identity_recognition_run_id UUID REFERENCES public.recognition_runs(id) ON DELETE SET NULL;
