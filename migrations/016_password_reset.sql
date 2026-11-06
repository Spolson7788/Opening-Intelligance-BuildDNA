-- Self-service password reset links. Store only the SHA-256 hash. One use, at most 30 minutes.
-- session_version already exists for admin-issued account recovery; do not add it again.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON public.password_reset_tokens(user_id, created_at DESC);

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.password_reset_tokens FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.password_reset_tokens FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.password_reset_tokens FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oi_pr2_api') THEN
    GRANT SELECT, INSERT, UPDATE ON public.password_reset_tokens TO oi_pr2_api;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'password_reset_tokens' AND policyname = 'oi_pr2_api_reset_select') THEN
      CREATE POLICY oi_pr2_api_reset_select ON public.password_reset_tokens FOR SELECT TO oi_pr2_api USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'password_reset_tokens' AND policyname = 'oi_pr2_api_reset_insert') THEN
      CREATE POLICY oi_pr2_api_reset_insert ON public.password_reset_tokens FOR INSERT TO oi_pr2_api WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'password_reset_tokens' AND policyname = 'oi_pr2_api_reset_update') THEN
      CREATE POLICY oi_pr2_api_reset_update ON public.password_reset_tokens FOR UPDATE TO oi_pr2_api USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;
