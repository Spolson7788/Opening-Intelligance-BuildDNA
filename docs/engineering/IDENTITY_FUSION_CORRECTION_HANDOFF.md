# OI identity fusion correction batch — independent review

Goal: correctly identify installed hardware from grouped photos of one device, retain photo-linked evidence, link technician truth to runs, score misses, and improve through reviewed changes. Offline checks alone do not demonstrate field recognition improvement.

## Implemented

- The trial locator still uses bounded whole-frame contexts, then each reader receives overlapping native-resolution search tiles covering the selected source photograph. The native search does not use PDQ-specific coordinates or expected text. Sticker and logo keep separate concurrent reader slots. No extra paid reader stage is added.
- Readers must return a native tile index, tight text box, rotation and target-device association. Unlocated context and declared other-device readings are excluded. Returned geometry is bounds checked, mapped to the native source, re-cropped and checked for pixel detail. Target-device association is still an AI assertion, not independently proved.
- A refined sticker may receive bounded local Tesseract corroboration at 0/90/180/270 degrees. Its replies and rotations are retained. OCR is optional for cast logos. Native tiles/rotations are transformations of the same photo, not independent evidence.
- Technician type provenance is sent to locator/readers/classifier. Defaults and AI-filled types are not technician evidence. A classifier type mismatch preserves the catalog proposal and yields TYPE_CONFLICT; the review form does not silently accept a conflict. Closer geometry is suppressed when a technician selected a different type.
- Identity matching uses reviewed static rows and approved/citable reference-document rows in one resolver. Manufacturer-specific decision literals are removed. Missing series/class/form stays unknown. Oversized/unavailable reference catalogs are recorded separately; verified local rows remain usable.
- CANDIDATES, CONFLICT, TYPE_CONFLICT, INSUFFICIENT_EVIDENCE, UNSUPPORTED_BY_CATALOG and CATALOG_UNAVAILABLE are distinct. Descriptions and series come from rows, never model prefixes or a fixed UI product string. Exact suffixes remain distinct; an uncertain unrelated token does not destroy the exact model token.
- Every completed photo run reaches the form's save payload, including shadow mode. Accepted AI suggestions retain AI provenance. Acknowledged corrections append history with shown suggestion, confirmed values, actor/time, supersession and run link. No acknowledgment or historical truth has been fabricated.
- Staging database migration adds append-only identity_confirmations and persistent recognition_miss_queue. Admin review routes are organization-scoped and exclude the submitting technician as reviewer. No automatic catalog/prompt update or purchasing-rule change is implemented.
- Export includes confirmation history and queued misses. Scorer separates correct/wrong/abstain/conflict, reports precision/coverage, includes series where catalog-supported, rejects mixed or unstamped builds, and retains the 20-distinct-held-out-device guard. Existing heterogeneous trial exports must be partitioned by stamped build before scoring.
- Free replay accepts both targeted-label-2 crop manifests and older reader manifests. It does not retroactively invent missing crop/context provenance.
- Additional comparisons require distinct actor/trial/photo/build audit grants. Existing costs, unknown reservations and scope hashes remain counted and unchanged. No paid recognition call occurred in this batch.

## Verification

209 recognition checks across 18 files passed. 34 database/budget checks across 2 files passed. 8 scorer checks passed. Root TypeScript and Field App production build passed. These include classifier-veto removal, exact suffixes, uncertainty in unrelated tokens, other-device/context exclusion, native tile coverage, unsupported/outage states, non-PDQ data-driven matching, append-only corrections, and explicit replay authorization.

The confirmation schema was applied only to staging. RLS is enabled; anonymous/authenticated Data API roles have no table access; server-only API role has necessary permissions. Security advisors reported no findings naming the new tables.

## Review targets and remaining limits

Review nativeLabelSearch.ts, labelReading.ts, catalogIdentityReview.ts, identityCatalog.ts, recognition.ts, hardwareIdentity.ts, recognitionStabilityBudget.ts, the confirmation migration, Field App identity review/save wiring, export/replay/scoring scripts and their tests.

Native source tiling is bounded to 20 tiles per selected source. Very large accepted sources can exceed that tile limit and will abstain; this batch does not claim universal 64MP recognition. Sending many native tiles may increase latency/input cost despite unchanged call count. Existing request and trial ceilings still apply. Field timing must be measured.

A coarse locator that completely misses or assigns the wrong source photo still has no guaranteed recovery; native tiling refines/searches the source selected for each reader. A second independent logo reader is not implemented. An exact AI maker/model pair is a reviewable proposal, not independently confirmed truth. A different-engine/model disagreement can remain undetected if OCR does not read a known alternative. Do not call these fixed without field evidence.

OEM/accessory relations are not newly imported or used to choose the maker of record. Incomplete catalog absence is not proof that a pairing cannot exist. Broader catalogs require reviewed source data, including component classes/forms. Confirmation history does not manufacture a missing series for a corrected product not in the run's catalog evidence.

Misses are persisted and reviewable, but prompt/catalog updates and a blind held-out promotion gate remain a separate implementation step. No Von Duprin/Yale held-out set is claimed frozen merely from prior attachment names.

## Next field criterion

On the new stamped build, analyze the same saved camera originals as one device with a deliberate Exit Device selection. Expected identity: PDQ / 6200 / 6200R, located native logo/sticker evidence, explanation of any rejected classifier estimate/type conflict, no irrelevant closer-arm analysis. The technician separately acknowledges or corrects the result; export and score the confirmation. Keep the earlier failed runs frozen. A single development case does not establish general accuracy or field-rollout readiness.


## Follow-up: locator interruption on the stamped field run

The first field attempt on baf85238 failed before native readers started: the locator exceeded its 12-second provider window, returned no reply, and kept its unknown-cost reservation. The saved-originals check had succeeded. This is an execution failure, not a measured identity result. Keep that failed run frozen.

The request omitted frontend type provenance even though the backend build was current. This suggests an older client; the cache cause is not established. The follow-up stamps the frontend, checks availability against that stamp, and rejects stale trial clients or missing provenance before originals preparation, run registration or a provider call. A locator failure with no reads now returns a stage-specific error. An interrupted reserved request stops subsequent stages and preserves the reservation. No paid retry is authorized by these safeguards; the trial remains paused.

Offline validation covers stopping the in-flight pipeline after an interrupted paid call without issuing a second request. The locator's fixed short window is still an execution bottleneck. A durable staged/background workflow with persisted stage outputs and independent reader budgets is the next implementation target; raising one timeout alone would consume the downstream reader window. These admission/error fixes are not evidence of improved recognition.


## Staged execution correction for the next controlled field trial

Camera-original trial requests now use two authenticated HTTP requests under one run and request ID. The first prepares originals, runs the locator with up to 30 seconds, saves its normalized region plan and source hashes, and returns a pending next stage. The second atomically claims that saved plan, prepares/verifies the same originals again, and gives the concurrent native readers a fresh 32-second stage budget. Each request retains a 55-second overall audit limit; source preparation can reduce the available stage window. No background job or unbounded wait is claimed.

Reader claims lock the run and bind organization, actor, opening, build, ordered photo IDs, attributes and request ID. Source hashes are compared again before reading. An active or expired active stage cannot be automatically retried. Duplicate claim rejection leaves the first claimant's run alone. Response-loss recovery only reads history and advances a persisted, unstarted reader stage; it does not repeat the locator or readers. The saved locator plan remains a separate exportable stage record after combined label evidence is written.

For this controlled identity trial, the extra shape classifier and reference-comparison calls are omitted. Identity comes from located maker/model reads plus reviewed catalog rows. Selected component type stays a technician hint and participates in conflict review; it is not truth. Catalog-backed component class still appears in the proposal. This reduces the paid ceiling to one locator plus at most two concurrent readers, without using silhouette guesses to fill identity.

Offline checks: 216 recognition/route checks across 19 files and 38 budget/history checks across 2 files passed, TypeScript and Field App builds passed. The two-request route test returns PDQ/6200/6200R from fixture label reads and makes no classifier call. Database tests exercise two competing reader claims and confirm exactly one succeeds. Tests cover changed source hashes, actor/build/input scope, expired active stages, response state and per-stage recovery clocks. These are not measured field accuracy.

Remaining limits: coarse locator can still choose the wrong source; AI logo reading can still fail; native tile cap and provider image limits remain. The fresh reader window is bounded and may still prove insufficient under field latency. Unknown costs remain counted; no cost reservation is refunded merely to authorize another test. No production deployment or live success is claimed.

Next controlled test: reload the protected preview, check the visible App build against the deployed commit, restore the saved originals if needed, select Exit Device deliberately, leave brand/model hints blank, and Analyze once. Expect progress to move from locating markings to reading the saved locations. Preserve the resulting run and score final PDQ/6200/6200R only against acknowledged technician truth.
