# Team member onboarding and email invites (M5)

Admins add people from Team > "Add team member" in one of two modes:

- **Set temporary password**: the account is created now. The person must choose their own
  password at first sign-in unless the admin ticks **Test account** (stored as
  `users.is_test_account`, audit-logged; defaults on for `.invalid` addresses, never inferred).
- **Email invite**: a `team_invites` row is created (token stored as SHA-256 only, 7-day expiry,
  single use, revocable). The invitee opens `APP_BASE_URL/dashboard/accept-invite#invite=...`
  and chooses a password. The token is in the URL fragment so it never reaches server logs.

Only admins can add people, and nobody can create a role above their own.

## Email provider: Resend

Chosen over SendGrid because it is a single HTTPS JSON call with one API key, needs no SDK,
and has simple DNS-based domain verification. The provider sits behind `EmailProvider` in
`src/services/email.ts`, so another provider can be added later.

Environment variable names (values are never committed or logged):

| Name | Meaning |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` |
| `EMAIL_PROVIDER_API_KEY` | Resend API key |
| `EMAIL_FROM` | Verified sender, e.g. `Opening Intelligence <invites@your-domain>` |
| `APP_BASE_URL` | Site origin, e.g. `https://oi-video-workflows-staging.netlify.app` |

If any of these is missing, invites are still created, the Team page says
"Email not configured, invite not sent.", and the token is never shown, logged or returned.
Resend later from the Pending invites list (resending rotates the token and resets the expiry).

Rate limits: 30 invite emails per organization per rolling hour; 60 s between sends of one
invite; at most 5 sends of one invite per 24 h (HTTP 429 with `retry_after_seconds`).

Audit log actions: Added team member, Created team invite, Resent team invite, Revoked team
invite, Accepted team invite, Changed own password. No tokens or passwords are recorded.