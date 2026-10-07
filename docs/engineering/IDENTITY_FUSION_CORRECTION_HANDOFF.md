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
