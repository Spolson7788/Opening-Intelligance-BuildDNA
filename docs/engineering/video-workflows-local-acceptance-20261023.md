# OI Field App and Facility Dashboard — local validation

Date: 2026-10-23. Scope: WP1 revision/retry prerequisites and WP2 canonical labels/component service requests. This is a local implementation milestone, not completion of the broader video roadmap or release approval.

## Delivered

Branch: feature/video-facility-workflows, based on tested candidate ce40fa8. Bounded commits: 4c316c9 (WP1), b1ad04b (WP2 API), 6a2bb13 (WP2 UI), followed by the browser-found visible label-preview fix in this report's commit.

The actual /facility-dashboard/ supports canonical single/reprint and selected batch labels, shared opening readiness, and component-specific service requests using the existing Field workflow. Requests preserve their opening/component/leaf attribution, queue locally during transport failure, and remain distinct from completed work, condition, or purchasing authorization. Provider delivery is disabled. Existing revision and receipt safeguards protect replay and stale writes; see the WP1/WP2 engineering reports for compatibility details.

Browser acceptance discovered that generated QR cards were hidden until printing. The fix displays the same cards in the dialog, clears them when selection changes, and retains the existing print-only sheet. An independent read-only reviewer found no concrete blocker in this bounded change.

## Local browser evidence

Used Edge on the user's computer, the actual built Dashboard and Field application, the actual API, and a disposable in-memory PGlite database bound only to loopback. Three synthetic paired openings and synthetic accounts were used. No hosted data, real messages, or physical printer were involved.

| Scenario | Observed result |
| --- | --- |
| Batch readiness | Two complete openings selectable; incomplete opening disabled with missing frame/leaves/hardware/completion reasons. |
| Batch generation | Two selected openings produced visible QR cards. Print file generation did not claim printing or affixing. |
| Single/reprint | PAIR-READY produced exactly the same QR image source as its batch label. Closing and reopening the preview preserved identity. |
| Component attribution | Request review explicitly identified the inactive-leaf closer, distinct from active-leaf closer. |
| Transport interruption | Harness closed local API connections. Submit displayed saved-on-device/pending synchronization and no notification sent. |
| Recovery | Restoring local API transport produced exactly one saved request; database target was closer/inactive and notification_status was disabled. |
| Account switch | Signing into an unrelated synthetic account in a second tab cleared the old Dashboard/request modal and showed zero authorized facilities. No second request was created. |
| Narrow layout | Actual Dashboard embedded in a 390px-wide local test frame: QR preview and request dialog remained readable and scrollable; paired-leaf target labels wrapped. |

Screenshots reside in ../acceptance-evidence relative to the repository: desktop-labels.jpg, narrow-label.jpg, narrow-request.jpg, account-switch.jpg, request-pending.jpg. database-result.txt captures synthetic saved request/target evidence. The initial mobile-label.jpg was a scaled desktop screenshot and is not mobile-layout evidence.

The browser viewport override did not change document layout width (still 1897px); therefore responsive evidence uses a real 390px iframe layout viewport. This is not a physical mobile-device test. Transport interruption tested failed-request queuing/recovery with the browser's online flag unchanged; it is not full OS-offline/service-worker acceptance. Repeated receipt/revision cases are automated tests, not a claim of real PostgreSQL concurrency.

## Automated validation

Previously completed: 183 distinct focused tests across offline recovery, API revisions, paired openings, service requests, labels, and purchasing gates; API/Field TypeScript checks; Field Vite/PWA build; Dashboard build. Detailed suite counts are in video-workflows-wp2-20261023.md.

After browser fix: `node node_modules/vitest/vitest.mjs run --config vitest.video-ui.config.ts`: 4 files, 22 tests passed (one added preview regression, formerly 21). Field production build and Dashboard generation passed. Independent preview review found no blocker.

An initial test invocation without the dedicated UI config failed because the default integration setup attempted localhost:5432. It was corrected to the existing dedicated UI config; this was not a passing PostgreSQL test. Total distinct tests represented by the earlier passes plus the added regression: 184; the entire 184 was not rerun in this acceptance pass.

## Remaining acceptance and boundaries

No postgres, psql, pg_ctl, or Docker executable, PostgreSQL service, standard PostgreSQL installation directory, or listener on 5432 was found. Real local PostgreSQL simultaneous duplicate/revision/revocation testing was unavailable, not denied. Nothing was installed. PGlite cannot establish multi-client PostgreSQL lock/concurrency behavior.

Still required before rollout: real PostgreSQL races and deployed runtime-role/schema compatibility; physical print dimensions, actual print-dialog cancellation and phone scanning; hosted private-site login return; real mobile/browser offline behavior. Existing automated parsing, authorization and replay tests support the code but do not replace these checks.

Offline request entry requires previously loaded context. New photographs are captured on component records first; this wizard attaches existing verified photographs. Notifications remain disabled. No push, deployment, production merge, hosted migration, credential/policy change, real PO/email, or recognition work occurred. The October 20 recovery workspace and its tests/fixtures were untouched.

## Bounded WP3 plan — not implemented

Source: October 19 18-page engineering plan, Library libfile_76c6ea7336c08191b9d65a8503207913, especially pages 5–7, 9 and 14. Reconcile current code again at package start; do not treat every plan item as missing.

1. WP3A: installation facts and history. Add confirmed/estimated/unknown certainty separately from day/month/year/unknown precision. Preserve entered precision, source and independent recorded_at; never invent a January 1 date or use registration as installation. Show installation first even when undated. Append corrections with actor, reason and previous fact preserved. Reuse tenant scope, revision014 and operation receipts. Acceptance: exact dates, month/year estimates, unknown dates, contradictory evidence and correction history, with unauthorized/stale/retry cases.
2. WP3B: component positions and replacement. Establish explicit frame/leaf positions and component-instance history without ambiguous automatic backfill. Replace atomically by retiring old instance and creating its successor at the same position; preserve old service/warranty history. Current completion, purchasing and condition projections include only current active instances. Acceptance: paired-leaf identity, one current closer per position, retired exclusions, failed/concurrent retry atomicity. Confirm any ambiguous legacy position mapping before dependent migration.
3. WP3C: condition evidence, downtime and warranties. Keep condition observations distinct from evidence-based reliability. Union overlapping unavailable periods, keep restricted operation separate and expose uncertain ranges. Separate product/labor warranty terms and proof; expiry alone is not coverage. Retain existing service event identity and count a multi-component job/cost once, with explicit allocations/unallocated amounts. Acceptance: overlapping intervals, unknown boundaries, replacement history, missing-photo states, warranty separation and no duplicated costs.

Deliver each package as a bounded local change with disposable DB tests and independent review. Procurement catalogs/estimates, immutable POs, budgets/invoices and recognition remain later packages. No new policy or live enablement is implied by this plan.
