-- Trusted administrator sets a provider-specific default service area. Filtering never grants access.
ALTER TABLE public.provider_memberships ADD COLUMN home_territory text CHECK (home_territory IS NULL OR btrim(home_territory)<>'');
