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

## Private deployment evidence

Remote commit ab00a7bb04162008c2ebb1a1d58f8a8a75a63925; tree 1ce61bf51d09f307fee62b138d028195f17db0fd. Netlify deploy 6aba709e58e0e10008eb836e published 28 September, approximately 06:51 America/Phoenix. Site 80fbbee8-b9d3-4b16-b93f-d2d8396591ec remains protected by Netlify Team protection; no recording-site or public production changes.

Netlify build log OI_FUNCTION_PACKAGE_EVIDENCE:
- api.zip: 1,788,275 bytes, SHA256 9e53851f1077c54020d20de540fa6c75e6630a2e0685ec2352fd8c680984acbb.
- photo-deletion-retry.zip: 991,291 bytes, SHA256 12780db2ca6fc05436590b3a17898f7e02507b603dbabfe9cd6eab1fffa89735.
- Function manifest SHA256 249ba1c8995ec5030768a60e3f172b584f31bfc967aeac33e569418c3c88ae8f.

These are build-side package hashes, not independent downloads of running Lambda bytes. Build installed locked dependencies, compiled both frontends and API, and deployed both functions. No schema change. Rollback: previous private deploy 6ab9876de306190008e2dc7f; it removes the diagnostic improvements. The local operator acceptance runner is now pinned to the new immutable deploy and commit but remains unexecuted against this backend.

## Initial hosted sign-in failure (resolved)

Candidate sign-in at 07:14:49 America/Phoenix returned support reference 1d021ce9-93d2-4b6e-a62d-a72a4c538e4f. Netlify API log confirms password_mismatch and the expected database target fdudsigbxumcpbxxxerb. This is a different account/backend from today's successful recording-account recovery. Do not alter the recording account or profile to address it. No further automated login or recovery attempt was made.

The current release administrator is active with session_version 1 (read-only verification by its designated UUID). The user subsequently completed manual sign-in successfully. Authenticated acceptance resumed without resetting or altering the recording account.

## Hosted results after successful sign-in

Tested the private isolated deploy above through its actual authenticated Field App and Dashboard, using the customer-organization administrator. These are not technician/provider A/B results.

- Opening SYNTHETIC-QA-RELEASE-FIELD-PAIR (f6ee2e93-4589-42e4-850e-643780f57dfc): paired leaves and their separately associated closers loaded. Existing synthetic service history was visible in the Dashboard.
- Changed active closer f05bf37d-da0e-415a-bc70-81ec5a480a7d cost from $250 to $251 through the Field App edit form. Dashboard showed $251 after Refresh saved records. Elapsed browser orchestration time from refresh click to the matching visible result was 497 ms; this is not a server latency measurement or automatic synchronization claim.
- Restored the cost to $250 through the same Field App form and verified $250 after Dashboard refresh. No test cost restoration remains pending.
- Reloaded Dashboard: authenticated records reappeared after initialization, including restored $250 and the synthetic service event. A transient login view during initialization was not treated as sign-out.
- State filter FL left only SYNTHETIC-QA-RELEASE-FL — Miami — FL; CA left only SYNTHETIC-QA-RELEASE-CA — Los Angeles — CA. Reload restored All authorized states for this unassigned administrator. My Territory currently contains only All authorized territories; meaningful named-territory and technician default acceptance remain open.
- Hosted purchasing review returned requirements unresolved and Review only — nothing is sent or ordered. The incomplete SYNTHETIC-QA-RELEASE-PAIR required completion/assessment/review; its serviceable hinge and the paired opening's serviceable closer were excluded as replacement not required. The worn active closer required an approved supporting document. No purchasing message or order was sent. This verifies refusal/exclusion behavior, not the positive approved-document route.

## Remaining bounded acceptance prerequisites

### Follow-up: named territories verified, designated accounts absent

On 28 September, a query limited to the two previously designated addresses (stg-tech-a@oi-nonprod.invalid and stg-tech-b@oi-nonprod.invalid) returned no rows on fdudsigbxumcpbxxxerb. This establishes absence of those exact accounts, not absence of every possible technician. No credentials were queried.

Set service_territory on only the two existing labelled synthetic release facilities, previously NULL: CA 33f3cbf5-1440-4d06-97fb-09d92f471c58 to SYNTHETIC-QA West; FL 52a002f3-7579-4f1f-9c60-ba0babc8fde7 to SYNTHETIC-QA Southeast. These retained demonstration labels do not grant access. Affected row count: two. The recording deployment/backend is untouched.

Live Dashboard after page reload: West selected only CA; Southeast selected only FL. Refresh saved records alone did not reload facility territory options. Live Field App Facilities and openings: West selected only CA; Southeast selected only FL; Southeast plus CA selected zero facilities; West plus CA selected one. Thus named-territory filtering is now verified for the signed-in administrator on both applications. Automatic California defaults for a technician and company isolation remain unverified.

Concrete next access setup: two synthetic provider organizations with separate technician principals, each limited to one of these synthetic facilities through owner-approved provider assignments. Provider A uses West/CA branch defaults; provider B uses Southeast/FL. Preserve current administrator and recording account. Do not copy password hashes, mint sessions, or re-use identities from another backend. Secure interactive account setup and a runner with network interruption controls remain required before executing the hosted A/B harness.

Browser tooling here does not expose controlled network interruption. The operator harness requires separately pinned synthetic A/B technician identities on fdudsigbxumcpbxxxerb and an authorized browser runner with interruption/restart controls before hosted offline/isolation acceptance. Prior-backend identities or results must not be substituted. Positive approved-document purchasing needs designated synthetic supporting-document evidence. California branch defaults remain required and are not accepted for narration from this administrator/state-filter test. No acceptance pass is inferred from the 13 configuration validation tests, which all pass after repinning. Production readiness remains withheld.
