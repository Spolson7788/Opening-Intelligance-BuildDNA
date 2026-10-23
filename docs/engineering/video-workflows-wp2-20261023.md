# Video workflow WP2: canonical labels and component service requests

Baseline: ce40fa8, isolated branch feature/video-facility-workflows. WP1 prerequisite
commit: 4c316c9. Requirements: October 19 engineering plan, Library
libfile_76c6ea7336c08191b9d65a8503207913, with the parent's confirmed WP2 scope.

## Delivered locally

- Actual Facility Dashboard detail has print/reprint and request-service actions;
  its toolbar opens a selectable batch-label preview (maximum 100 openings).
- Field and Dashboard use the same label service and preview. Existing opaque
  tokens never change on rename, reprint, cancelled preview, or retry. Generation
  records only `print_file_generated`, never physical printing or affixing.
- Readiness checks require complete opening, frame, required single/paired leaves,
  assessed conditions and reviewed hardware. Ineligible items are visible and
  blocked. Retired openings cannot generate/replay labels or create requests.
- Letter cut-label and single 2-inch layouts include facility/building/opening
  captions and a four-module QR quiet zone. Physical fit/scannability is untested.
- Scanner accepts the server-configured canonical Field URL or bare legacy UUID
  token, rejects unrelated hosts, credentials, extra routes, query/hash additions,
  and preserves a safe login return path. QR is never authorization.
- Shared Field request wizard is embedded in the actual Dashboard, using its
  existing same-origin session, API and durable IndexedDB queue. Requests select
  frame/leaf/components (including correct paired leaf) or explicitly uncertain
  opening-level intent; symptom, impact, priority, assigned provider, verified
  existing photos and a review step precede submission.
- Service requests persist separately from completed service/condition/purchasing.
  No opening-completion prerequisite is imposed on asking for service. Existing
  whole-opening purchasing and technician-review gates are preserved.
- Offline state says pending; server receipt says recorded, with notifications
  disabled. No outbox/delivery transport exists. Provider assignments and requester
  scope are rechecked before creation and receipt replay. Request targets/photos
  cannot cross openings; selected photo attribution is checked explicitly.
- Reload resumes a pending request. An explicit separate-request action retains
  earlier history. Same-operation local payload checks are transactional. Account
  changes cannot reassign a retained form or queued operation to another user.

## Database change

20261023211529_video_service_requests.sql was created using the Supabase CLI and
moved to the repository's established migrations directory. It was applied only
to disposable in-memory PGlite, never a hosted database. Three request tables and
composite target/photo constraints preserve canonical IDs. Existing receipt type
validation adds service_request. RLS and existing trusted API-role policies allow
the Express server; there are no direct-browser grants/policies.

Deleting a photo cascades only its request link; the immutable receipt preserves
the historical photo ID. This avoids interfering with existing private-media
cleanup. Deleting hardware referenced by a request returns an explicit 409.

## Verification

- API and Field TypeScript checks: pass.
- Field production build with OI_UI_BASE=/field/: pass, including service worker.
  Existing large-bundle warning remains (about 736 KB before gzip).
- Actual Facility Dashboard build: pass; generated detail and toolbar include
  the new modules/actions. Full browser interaction was not performed.
- vitest.offline.config.ts: 106 pass (existing offline/photo/principal coverage).
- vitest.video-ui.config.ts: 21 pass: strict parser/login returns, print-selection
  response race, account-bound edits/queue, offline lost-response recovery,
  competing local request payloads, wizard remount, explicit separate request,
  and opening-route reset. UI cases use jsdom; transport recovery uses mocked HTTP
  and fake IndexedDB, not a phone/browser acceptance run.
- Disposable API suites: videoLabels 2, videoServiceRequests 5, batchQrCodes 5,
  providerPurchasing 2 pass. Request tests cover non-bypass API-role reads/inserts
  and denial for a synthetic browser role even when it receives table grants.
- WP1 API regressions rerun individually in fresh databases: videoWorkflowRevisions
  5, pairedOpenings 12, offlineSyncApi 25 pass. Across the listed suites, 183 tests
  passed. See WP1 report for compatibility constraints.
- Independent read-only reviewer checked receipts, reauthorization, revisions,
  canonical host parsing, local queue and wizard recovery. Findings were fixed:
  form principal binding, canonical config, retired status, runtime RLS policies,
  photo deletion compatibility, property-lock-before-authorization, route remount
  and pending-request recovery. Final source review found no remaining blocker.

The initial request-context test exposed a missing UUID cast, fixed and rerun.
Expected SQL denial is caught within SQL in the RLS test because the PGlite socket
adapter mishandles error frames followed by another client query. This does not
establish real PostgreSQL multi-client concurrency behavior. Dependencies were
copied from an existing local workspace cache, not installed from a clean lockfile.

## Remaining acceptance and boundaries

- Real PostgreSQL duplicate-write/revocation races and hosted role/schema checks.
- Actual desktop/mobile browser, printed dimensions, phone scanning, print-dialog
  cancellation, iframe interaction and private-site login round trip.
- Offline request entry needs a previously loaded request context. New photos
  are captured on the component record first; only verified existing photos are
  selectable here. No inline new-photo capture or real provider delivery.
- No facility rollout flags or hosted enablement were changed. Future rollout
  needs coordinated API migration/client deployment; old changed component edits
  without expected revisions return 409 as documented in WP1.
- Installation lifecycle, catalogs/estimates, sandbox PO/budgets/invoice packages
  await their next requirements boundary. Recognition was not started.

No deployment, push/merge, real notification/order, credential or hosted policy
change occurred. The October 20 recovery workspace/tests/fixtures are untouched.
