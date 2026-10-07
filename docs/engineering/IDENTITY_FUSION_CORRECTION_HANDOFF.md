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


## Measured field outcome on 451b4026: identity target failed

The controlled saved-original run completed the locator and both native readers. Locator latency was 7.839 seconds; the maker reader completed in 7.539 seconds and the sticker reader in 10.852 seconds. All three raw responses and usage records are persisted. Total estimated provider cost for this attempt was $0.146517, with no unknown charge added by this attempt. Prior unknown reservations remain fully counted. The granted run was consumed; no further test was granted.

The maker reader transcribed DORMA, incorrectly, and returned a native-tile text box whose recropped pixels failed the detail check. Its location was therefore unvalidated and the reading excluded from catalog identity. The UI nevertheless prominently repeated this raw transcription. Final brand, series and model were all null. This is a recognition miss, not successful recognition because the safety filter excluded the wrong name.

The sticker reader's raw reply actually included Model 6200R in native tile 10. It placed explanatory prose before a complete fenced JSON object. The strict envelope parser rejected the whole reply before reading validation, losing the correct model transcription. This is a processing defect separate from the incorrect maker read.

Follow-up: label-response-3 accepts one complete fenced JSON object with surrounding prose while retaining exact transcription and coordinate bytes. Multiple fences/objects, malformed JSON, refusal and truncation remain rejected. The original run remains frozen. Free replay of its saved raw replies preserves PANIC HARDWARE / Model 6200R and also preserves the wrong DORMA transcription; no new provider call was made. Native-pixel location revalidation was not performed by this parser-only replay. It does not establish final PDQ identity.

The UI now calls the raw text an unverified AI transcription and explicitly says it is not an established manufacturer/model, while retaining excluded readings and reader details. This wording is not a recognition improvement. Offline validation: 218 recognition checks pass; TypeScript and Field App build pass.

Next recognition work must validate and refine the actual maker-mark location, provide focused correctly oriented native mark pixels, and independently review cast-logo failures without inferring the maker from a model-only catalog match. This field result does not justify another paid run of unchanged reader inputs.


## Focused native verification correction

The saved reader location is now treated as a geometric proposal rather than trusted transcription. A third saved request can claim focus_ready under the same run, with actor/opening/build/input/source-hash checks and a single-use locked claim. It takes at most two target-device native-tile proposals, adds a 60% native-pixel margin on each side to retain clipped characters, and sends native 0/90/180/270 crops plus source context. Oversized crops above 1568 pixels abstain rather than silently lose native detail. No device-specific coordinates, expected manufacturer/model, catalog options or previous guess are supplied to this focused call.

The focused response must locate all transcribed characters in the unrotated focused crop. Coordinates map back to the original image, and the exact native recrop receives the pixel-detail check without the old cropLabel enlargement/padding. This validates image detail and location, not semantic correctness. Target-device association is still an AI assertion. Four orientations are not independent observations, and the second call uses the same engine; no independent confirmation or calibrated accuracy is claimed.

All initial and focused reads remain in evidence. Two validated disagreeing maker reads cause CONFLICT. An unvalidated initial DORMA read remains excluded and cannot veto a newly located maker/model proposal merely by repetition. Failed focused calls retain earlier evidence. Native originals are fetched and checksummed again for the focused stage. The UI shows locating, reading, then focused verification; interrupted stages are not automatically retried. Completion marks the execution phase completed.

Diagnostic: applying the new margin to the failed maker proposal on the available 1536x2048 chat photo copy produces a 212x437 crop whose 90-degree view clearly shows PDQ. The earlier reader proposed 270 degrees. This is a diagnostic on a resized copy, not pixel verification of the private camera original and not an OI recognition score. The production algorithm takes its proposal from each run rather than those development coordinates.

Offline validation: 226 recognition checks across 20 files, 39 budget/history checks across 2 files, TypeScript and Field App build pass. Tests cover native rotation/pixel equality, clipping/oversize abstention, coordinate mapping, withheld guesses, prior-evidence retention, valid-maker conflicts, and single-use focused-stage claims. The fake-reader tests do not measure field accuracy.

One controlled comparison is permitted by Stephan's Proceed through to completion directive within the existing cumulative $5 cap. The new path has at most four paid calls (locator, two initial readers, one focused verification), with a $2.496 conservative maximum reservation. All previous costs and unknown reservations remain counted. Previous field runs stay frozen. Production remains unchanged. Final PDQ/6200/6200R with localized evidence is the still-unproven field criterion.
