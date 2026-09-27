# Server function verification — 27 September 2026

Verdict: PASS for build-to-deployment package provenance and bounded worker startup. Independent extraction of running Lambda bytes is not claimed. This is not production approval.

## Completed evidence

The protected preview build at commit 96e4268bc51aa89403f4ff7c18f1edad5d985f22, tree 3bce5a768e41396f4ad8c82c6e6ff3d3cde511e0, deploy 6ab951cf9494f400073efee8 completed successfully, with plugin_state success and published_at null. The build plugin runs after function bundling and hashes Netlify FUNCTIONS_DIST ZIP bytes, not source files. It exposes only hashes, sizes and build identity. Five focused tests pass. Production is unchanged.

The exact JSON emitted in the authenticated build log was reconstructed and independently hashed: 617 bytes, SHA-256 1392ecdf3d52edc4ee2967b096e41205be8b78c32a1142113e40f2dbacfaca7a, matching the separate build log hash. See function-package-evidence-20260927.json.

- api: 1,772,273 bytes; SHA-256 84b6e416133c5ae47d2200e11b1bcb24d2ae25ba7222531f4cdb19cd14c7ed2a.
- photo-deletion-retry: 991,086 bytes; SHA-256 d45e7b71ad161b3b57f51cec5e3a8315ff63680b868d59682873cf4038c90f57.

The deploy log reports zero new functions to upload and successful deployment initiation. This is provider evidence of reuse; it is not an independent runtime-binary download. Application and function source is unchanged from the accepted candidate; new work is migration reconciliation plus build evidence. The existing 17 hosted behavior checks retain their original candidate identity and are not misrepresented as rerun on this deployment.

## Worker smoke test

Before the build, the existing accepted preview worker was invoked through Netlify Run now at 2026-09-27 17:24:19 UTC (10:24:19 Arizona). Log reference 6f8d8463: photo_deletion_retry, claimed 0, finalized 0, retrying 0; duration 1103.9 ms. Database queue was empty before and after. No photographs were deleted. This proves invocation, staging database access and an empty-queue successful return, not deletion/retry processing of a real job.

Netlify scheduled functions run automatically only on published deploys. The preview worker correctly shows Manual; absence of automatic ticks on this preview is not a defect. Automatic scheduler operation belongs to the approved published-environment smoke test. Source: https://docs.netlify.com/build/functions/scheduled-functions/

Build hook documentation: https://docs.netlify.com/extend/develop-and-share/develop-build-plugins/

## Recording and release

Keep recording pinned to 6ab91b823b51d50008904398 and the existing released handoff. Its URL and synthetic records remain unchanged. The moving PR9 preview alias now points to the evidence build; do not substitute it into a pinned recording session. No repeat operator login or 17-case run requested.

Production still requires its own configuration, monitoring ownership, approved migration/deployment sequence and published-worker smoke test. These are release operations, not silently passed by this preview.
