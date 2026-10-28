-- M5: team member onboarding. Additive only. No existing row changes meaning:
-- new users columns default to the current behaviour (no forced change, not a
-- test account, no default facility).
--
-- users.must_change_password  set by direct add with a temporary password; the API
--                             then allows only /auth/me and /auth/change-password.
-- users.is_test_account       explicit admin choice (never inferred); test accounts
--                             skip the forced change.
-- users.default_property_id   field-app pre-selection only; NOT a permission.
-- team_invites                email invites. The token is stored ONLY as a sha256
--                             hash; single use, expiring, revocable.
-- team_invite_sends           one row per send attempt (rate limit + history; no token).
-- Undo: docs/rollback/20261029090000_member_onboarding_rollback.sql
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN is_test_account BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN default_property_id UUID NULL REFERENCES properties(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN created_by_user_id UUID NULL REFERENCES users(id);
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ NULL;

CREATE TABLE team_invites (
 id UUID PRIMARY KEY,
 organization_id UUID NOT NULL REFERENCES organizations(id),
 email TEXT NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
 full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
 role TEXT NOT NULL CHECK (role IN ('admin','facilities_manager','technician','inspector','viewer')),
 default_property_id UUID NULL REFERENCES properties(id) ON DELETE SET NULL,
 invited_by_user_id UUID NOT NULL REFERENCES users(id),
 token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_sent_at TIMESTAMPTZ NULL,
 email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sent','not_configured','failed')),
 accepted_at TIMESTAMPTZ NULL,
 accepted_user_id UUID NULL REFERENCES users(id),
 revoked_at TIMESTAMPTZ NULL,
 revoked_by_user_id UUID NULL REFERENCES users(id),
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
 CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)),
 CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
);
-- At most one open (not accepted, not revoked) invite per organization and email.
CREATE UNIQUE INDEX team_invites_one_open ON team_invites(organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX team_invites_org_created ON team_invites(organization_id, created_at DESC);

CREATE TABLE team_invite_sends (
 id UUID PRIMARY KEY,
 invite_id UUID NOT NULL REFERENCES team_invites(id) ON DELETE CASCADE,
 organization_id UUID NOT NULL REFERENCES organizations(id),
 sent_by_user_id UUID NOT NULL REFERENCES users(id),
 outcome TEXT NOT NULL CHECK (outcome IN ('sent','not_configured','failed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX team_invite_sends_org_time ON team_invite_sends(organization_id, created_at DESC);
CREATE INDEX team_invite_sends_invite_time ON team_invite_sends(invite_id, created_at DESC);

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invite_sends ENABLE ROW LEVEL SECURITY;