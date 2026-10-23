# Video workflow prerequisites — WP1

Local implementation baseline: ce40fa8dc52751249d2560c948ca53b15d8f67e0,
branch feature/video-facility-workflows. Main-only divergence comprises narration
and video-generation work; no merge was needed for this application slice.
Requirements: October 19 Facility Dashboard engineering plan, Library
libfile_76c6ea7336c08191b9d65a8503207913, WP1 and identity invariants.

## Changes

- Reuse migration 014 revisions and transactional receipt/audit tables. No migration.
- Hardware create/update retries with operation IDs replay their original result;
  a changed payload or different actor cannot reuse the receipt.
- Hardware PATCH requires the observed revision; checks and mutation are serialized
  on the component row. Frame/leaf sync also validates revisions and keeps identity.
- Direct structure writes cannot bypass revision checks. Identical old-style
  structure requests remain no-ops with unchanged identity/revision.
- Field editing submits the revision the form actually loaded. It never silently
  adopts a newer cached revision for stale form contents. A second structure edit
  requires sync/refresh; pending/conflicted local work is not overwritten.
- Purchasing rules and photo storage/recovery implementations are unchanged.

## Verification

Run database suites individually using `node scripts/test-connected-video.mjs <test>`.
Each run creates a disposable in-memory PGlite database on loopback, applies the
existing migrations there, then discards it. No hosted database was used.

- videoWorkflowRevisions: 5 pass (paired closer identity, create/update replay,
  changed payload, different actor, cross-opening/tenant targets, stale revisions,
  and unchanged direct structure retries).
- pairedOpenings: 12 pass.
- offlineSyncApi: 25 pass.
- providerPurchasing: 2 pass. The two update calls now supply expected revisions
  and assert status 200; all existing purchasing assertions remain.
- vitest.offline.config.ts: 106 pass, including principal-change/photo recovery.
- API and Field TypeScript checks pass.
- Field production build passed, including service-worker generation. The final
  service-worker step took longer than the initial progress checkpoint.

The initial multi-suite database run suffered adapter connection failures after
the first suite. Individual fresh-database runs above supersede that attempt.
This serialized adapter does not establish concurrent remote Postgres behavior.

## Compatibility and limits

Old clients may create records and replay existing versioned receipts. Changed
updates lacking an expected revision now return 409 rather than overwrite data.
They need the refreshed Field client; old queued ambiguous structure edits remain
retained conflicts for review. An ordinary hardware create from before receipt
tracking with an already-used operation ID is not silently reinterpreted.

No production/staging deployment, notification, credential/policy change, or live
data write. The October 20 recovery workspace and its evidence are untouched.
WP2 label/request functionality is not included in this prerequisite change.
