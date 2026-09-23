# OI password recovery — release gate

Development branch: `feat/oi-password-reset` from the frozen staging commit
`6d5d67ce3af1d4b5155ddadccd2498aade26b23d`. This feature has not been
deployed and does not change the frozen R8 video build.

Both OI login pages now link to a reset request page; the email link opens the
Dashboard's reset page and applies to the same OI account. For an active account
with a reachable email address, the API creates a 256-bit random token, stores
only its SHA-256 hash, and emails a 30-minute, one-use link. The link carries
the token in a URL fragment. A successful reset replaces the bcrypt password
hash, consumes all that user's pending links, invalidates prior OI sessions,
and requires a normal sign-in. Unknown accounts and throttled accounts get the
same public response. The requester cannot specify an organization or target URL.

The Dashboard also offers **Change password** in the signed-in account menu.
It verifies the account's current OI password, accepts a new one, revokes all
previous sessions, and signs out the browser. This route does not require a
mail provider, but still requires migration 016 for session revocation. The
forgotten-password link remains separate and needs a configured email sender.

## Before a nonproduction preview can offer working resets

1. Apply migration `016_password_reset.sql` to the **nonproduction** database
   matched to the preview. Confirm the reset-token table has RLS enabled and
   no browser Data API grants.
2. Configure a verified email sender with Resend and set `RESEND_API_KEY`,
   `PASSWORD_RESET_FROM_EMAIL`, and `PASSWORD_RESET_PUBLIC_URL` as private
   server-side environment variables. The URL must be the HTTPS origin of
   the intended protected preview, ending in `/`. Never publish the API key.
3. Deploy a **new nonproduction preview** from this branch. Preserve deploy
   `6ab3c34c4a8f560008201f71` and its evidence unchanged.
4. On the preview, request a reset for an account with a real reachable mailbox;
   verify receipt, expiry, one-use behavior, old-session revocation, new login,
   and organization membership. Verify no email or link goes to an `.invalid`
   fixture address and no tokens appear in logs. Only then describe the option
   as available to field users.

No email sender or mail service was configured or called during this branch's
local tests. A reset request returns `503 password_reset_unavailable` until
all three required settings are present.
