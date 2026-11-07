# SEC-2 staff authenticator — operator notes

This is not a production change. The migration file is in the repository and has not been applied.

Staff (rows in `platform_staff`, currently Stephan and Michelle) enter the password they already use, then a 6-digit code from an authenticator app. Customers sign in the same way they do today.

The setup QR code, the typed setup key, and the 10 recovery codes are returned only by the enrollment response. Each recovery code works once. Store the codes somewhere safe before leaving that screen. A later sign-in does not show them again.

If one staff member loses the phone, the other staff member — already signed in with their own authenticator code — opens OI staff tools, chooses Reset authenticator, and records a reason after checking identity on a known phone number. The reset person enrolls again. They cannot reset their own authenticator with a password alone.

## Staging, only after Stephan names the target and approves these steps

Do not use oi-production (`bekaxmatcvxqpjixwsqn`). Do not use `fadihkhdwpfffpelqjtg`, `ytqiulxtiharrplqnuir`, `fdudsigbxumcpbxxxerb`, or `ioqfdcehnhnqpnqawwvo`. Do not run `npm run migrate` against production.

1. Set `STAFF_MFA_ENCRYPTION_KEY` on the staging API to a new 32-byte key, standard base64 (44 characters, ending in `=`). Generate it locally. Do not commit it. Do not log it.
2. Apply only `migrations/20261107130500_staff_mfa.sql` to the named staging database. This adds staff authenticator tables and one audit action. It does not change `platform_staff_regrant`.
3. Deploy this branch's API, dashboard, and field app to the named staging sites. Deploying the API before the migration and the key locks staff out (the server will not fall back to password-only). Customers can still sign in.
4. Stephan and Michelle each sign in on the dashboard and the field app, scan the QR code once, save the recovery codes, and enter the current 6-digit code.
5. Check a customer account still signs in with a password only and cannot open staff tools.
6. With one staff account signed in, reset the other account's authenticator, confirm the reset person must enroll again, and confirm the audit log has the reason and no codes.

Rollback is `docs/rollback/20261107130500_staff_mfa_rollback.sql`, applied only with the application rolled back in the same approved step. Rolling back the tables while this API stays deployed does not restore password-only staff access.
