# WP3A — installation-first lifecycle milestone

Branch: feature/video-facility-workflows, following WP1/WP2 commit 35b628c. Source: October 19 Facility Dashboard engineering plan (Library libfile_76c6ea7336c08191b9d65a8503207913), pages 5–7, 9 and 14; parent directive to deliver the first bounded installation milestone before broader expansion.

## Implemented

- Additive installation_facts table: confirmed/estimated/unknown certainty, independent day/month/year/unknown precision, source reference and notes, separate recorded timestamp/actor, explicit opening/frame/leaf/component attribution.
- Strict calendar validation without fabricated first-day/month values. Confirmed facts require an identified non-recollection source; this records the user's assertion, not independent document verification.
- Append-only correction chains preserve prior values, recording attribution and reasons. Initial root identity includes target type as well as UUID. SQL update/delete protection preserves this history.
- GET /api/lifecycle/:openingId and POST /api/lifecycle/installation-facts. Transactions reuse existing opening revisions and receipt/audit machinery, reauthorize prior receipts, reject changed payloads/actors, validate same-opening targets and stale corrections.
- Existing install_date fields are untouched and returned explicitly as unreviewed legacy source values. Existing service_events IDs, content, dates, component linkage and costs are not migrated, copied, or rewritten.
- Online-only installation-first Field screen, linked from Opening details and the actual Facility Dashboard. Shows unknown installation before recorded service; preserves superseded facts and legacy values; supports entry/correction and identical retry of uncertain submissions.
- Existing role rules are unchanged: admin/facilities_manager can write through this new route; other authorized roles can read. No technician-write permission expansion is implied. Retired openings remain read-only. This boundary is explicit in the UI.

## Tests and review

Passed using fresh disposable PGlite databases per suite through the repository's existing single-connection runner:

- `node scripts/test-connected-video.mjs tests/installationLifecycle.test.ts`: 8 tests.
- `node scripts/test-connected-video.mjs tests/videoWorkflowRevisions.test.ts`: 5 tests.
- `node scripts/test-connected-video.mjs tests/videoServiceRequests.test.ts`: 5 tests.
- `node node_modules/vitest/vitest.mjs run --config vitest.wp3-ui.config.ts`: 4 UI tests.
- API and Field TypeScript checks; Field Vite/PWA build; actual Dashboard generator; git diff whitespace check.

The 22 passing tests above cover date precision/leap years, unknown facts, legacy date preservation, original service IDs, paired-leaf attribution, append-only history, retry/actor binding, stale revisions/corrections, revoked-provider access, cross-tenant reads, overlapping UUIDs across target kinds, frozen uncertain UI retries, account remount, and deleted-selection reload recovery.

Independent read-only reviewer found two defects: target-type omission from root uniqueness and stale selection after reloading a deleted component. Both were fixed with regression tests; final review found no remaining blocker in this bounded slice.

An initial test fixture omitted required tracker/password fields and was repaired. An attempted combined integration run suffered the known PGlite socket/pool failure; it is excluded from passing evidence. Individual fresh-database runs above supersede it. No claim of real PostgreSQL concurrency is made.

## Remaining work and limits

This is WP3A, not complete WP3 or complete video implementation. Replacement positions/links, retirement/current-projection filters, downtime union/ranges, warranties/document proof, condition observations, multi-target cost allocation and later procurement work remain ahead. No replacement or retired-component exclusion was silently added; all existing components remain in current calculations until the coherent replacement package updates those consumers together.

Next replacement slice must first map every current consumer (completion, purchasing, condition/health, exports, request context, photos and service history) and introduce explicit positions without guessing ambiguous legacy hinge/closer assignments. Replacements must preserve old IDs/history and switch current-instance projections atomically. Real PostgreSQL concurrency remains unavailable locally, not denied. Physical QR/print, hosted acceptance and new lifecycle browser/layout acceptance remain unverified.

Other limits: the new screen requires connectivity and does not persist an offline command queue; a page reload can discard its in-memory retry envelope, so users should reload saved facts before changing uncertain submissions. Root/correction uniqueness prevents silent duplicate installation chains. The API currently returns the opening's complete installation/service history; stable pagination and document-version provenance remain follow-up work. No replacement UI or warranty coverage claim is present.

No push, deployment, hosted schema operation, live role/policy change, external send, recognition work or modifications to the October 20 recovery artifacts occurred. Migrations ran only against disposable local databases.
