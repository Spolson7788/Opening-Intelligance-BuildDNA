# SEC-2 staff sign-in code

Staff (rows in `platform_staff`) enter their password, then a 6-digit code emailed to their account address. Customers are unchanged. There is no authenticator app, QR code, or recovery code.

The email uses the same Resend sender as password reset (`RESEND_API_KEY` and `PASSWORD_RESET_FROM_EMAIL`). Subject: "Your Opening Intelligence sign-in code". The code expires in 10 minutes and works once. A new code replaces the previous one. Resend waits about 60 seconds. The code screen is kept in the browser so leaving for Mail and coming back does not start over or send another code.

Five wrong codes in 15 minutes lock that person out. The other staff member, already signed in with a code, can clear the lockout from OI staff tools and must give a reason. Nobody can clear their own lockout. The audit record has the reason and no code.

`STAFF_MFA_ENCRYPTION_KEY` is not used.

## Staging, only after Stephan approves these steps

`migrations/20261107130500_staff_mfa.sql` is already applied on staging. Do not edit or re-apply it. Do not use oi-production (`bekaxmatcvxqpjixwsqn`). Do not use `fadihkhdwpfffpelqjtg`, `ytqiulxtiharrplqnuir`, `fdudsigbxumcpbxxxerb`, or `ioqfdcehnhnqpnqawwvo`. Do not run `npm run migrate` against production.

1. Confirm the staging API already has `RESEND_API_KEY` and `PASSWORD_RESET_FROM_EMAIL` (the password-reset sender). No new secret is required. `STAFF_MFA_ENCRYPTION_KEY` can be removed; the API does not read it.
2. Apply only `migrations/20261107143000_staff_sign_in_codes.sql` to the named staging database. It adds the hashed code table and allows email attempts on the existing lockout table.
3. Deploy this branch's API, dashboard, and field app to the named staging sites. If the API is deployed before the new migration or before the Resend settings, staff cannot finish sign-in. Customers still can.
4. Stephan and Michelle each sign in on a phone: password, switch to Mail, copy the code, return to the same screen, and enter it. Use Resend only if the first code is not there.
5. Confirm a customer still signs in with a password only and cannot open staff tools.

Rollback of this step only, with a separate approval and together with rolling back this application build: `docs/rollback/20261107143000_staff_sign_in_codes_rollback.sql`.
