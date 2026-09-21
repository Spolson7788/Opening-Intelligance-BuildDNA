# Staging database TLS correction

The hosted signup at deployment 6ab07b80b3d3a8579405e039 fails with
SELF_SIGNED_CERT_IN_CHAIN during pool.connect. Read-only verification after
two attempts found zero users, organizations and portfolios.

Supply the official Supabase CA PEM as DATABASE_CA_CERT, Functions scope,
exact branch pr2-staging. It is public certificate data, not a credential.
Leave DATABASE_URL and all secrets unchanged. The existing verify-full URL
is supported; pg's URL SSL override is removed only after validating its
mode so the explicitly trusted CA and rejectUnauthorized:true survive parsing.
Node's default hostname verifier remains active. Conflicting TLS parameters
are refused. No global trust store or verification-disable switch is used.

Signup connection failures return503 database_unavailable before any SQL
write, without logging connection details. The existing transaction is unchanged.

Free checks: databaseTls11 and signupConnectionFailure1 pass using Vitest4.1.11,
Node24.19.0; TypeScript and diff checks pass. No hosted TLS success asserted yet.
The first isolated signup test failed because its harness omitted JWT_SECRET;
rerunning with an explicit synthetic test-only value passes. No account was
created by these tests.

A replacement protected staging deployment and the branch-only CA variable
are needed to test the real connection. No production, R8 or video edits.
Before the user retries signup, restore Your name to STG-20260920-01 Admin A
and use stg-admin-a@oi-nonprod.invalid in Email. The password remains private.
