# Authentication recovery and release follow-up — 28 September 2026

## Recording deployment: restored, unchanged

Site 6430c57d-8a98-43bc-ba25-94007dd244f2; immutable deploy 6ab91b823b51d50008904398; commit 7fbaa93d4a1bc95b54807260a6c039ec1734b6c7; backend ioqfdcehnhnqpnqawwvo.

Recovery committed at 2026-09-28 13:24:00.642035 UTC. Designated recording account remains active; session_version increased from 0 to 1; the single-use token was consumed. No credential values are retained here.

Netlify API function logs for Preview #9 were inspected directly:
- 06:28:27 America/Phoenix, support reference 669586a9-a231-4780-baef-4ffbe039d1cf: password_mismatch.
- 06:28:50, reference 62d8ba91-4dbb-4be9-a060-bc0f55d1079e: success.
- 06:31:16, reference f324930c-d17a-47c0-9ef1-773ad104f1bb: success.

Fresh authenticated browser verification loaded QA West / CA preferences, the California synthetic facility, and SYNTHETIC-QA-20260926-PAIR. Pair includes one frame, two leaves, separate active/inactive closers, recent synthetic service, and two successfully decoded component photographs (503x423 and 640x480). This validates current read access, not production acceptance or the separate recording browser session.

## Historical limitation

The earlier pre-sign-out GET 401 was not instrumented with an application correlation reference. Its cause remains undetermined; the later password mismatch does not establish its cause. The prior recovery-service error likewise has no conclusive correlated failure record. A successful reset is recovery evidence, not proof that every historical failure is fixed.

## Correction for isolated release candidate

- Distinguish application credential rejection from hosting/non-JSON access responses.
- Never treat HTML 200 as successful password recovery.
- Correlate denied authenticated requests using a server-generated UUID in the response and log, preserving existing fail-closed behavior.
- Log only a reference and bounded outcome; do not log tokens, headers, URLs, queries, request bodies or user identifiers. Expired and invalid tokens are distinguished server-side while preserving the existing client error contract.
- Preserve correlation reference in Field App API errors.
- Reproduce the provisioned runtime-role prerequisite in the disposable local database runner.

Verification: 11 focused auth response/authorization tests pass; API TypeScript build passes; Field App production build passes; 13 database-backed auth/provider-purchasing/branch-default tests pass using disposable PGlite. These local results are not hosted A/B or interruption acceptance.

## Release gates still open

The isolated release uses backend fdudsigbxumcpbxxxerb. Authenticated provider A/B isolation/revocation, controlled interruption/restart/response-loss/account-switch checks, positive approved-document purchasing, technician-specific territory defaults and final artifact reconciliation must be evidenced there. Existing staging tests must not be substituted. No public production cutover authorized by this report.
