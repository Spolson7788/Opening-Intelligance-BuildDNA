-- Nonproduction recovery codes are issued only by the authorized operator.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE public.account_recovery_tokens (
 token_hash TEXT PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX account_recovery_user_idx ON public.account_recovery_tokens(user_id);
ALTER TABLE public.account_recovery_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_recovery_tokens FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.account_recovery_tokens FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.account_recovery_tokens FROM authenticated; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='oi_pr2_api') THEN
  GRANT SELECT,UPDATE ON public.account_recovery_tokens TO oi_pr2_api;
  CREATE POLICY api_recovery_select ON public.account_recovery_tokens FOR SELECT TO oi_pr2_api USING(true);
  CREATE POLICY api_recovery_update ON public.account_recovery_tokens FOR UPDATE TO oi_pr2_api USING(true) WITH CHECK(true);
 END IF;
END $$;
