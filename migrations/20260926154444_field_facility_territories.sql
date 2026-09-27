-- Geography narrows company-authorized results; it never changes authorization.
ALTER TABLE public.properties ADD COLUMN service_territory text CHECK(service_territory IS NULL OR btrim(service_territory)<>'');
ALTER TABLE public.users ADD COLUMN home_state text CHECK(home_state IS NULL OR home_state ~ '^[A-Z]{2}$');
ALTER TABLE public.users ADD COLUMN home_territory text CHECK(home_territory IS NULL OR btrim(home_territory)<>'');
