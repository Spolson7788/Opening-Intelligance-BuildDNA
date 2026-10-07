# Grok review — grouped field recognition candidate

Goal: OI identifies brand, series and model from grouped real field photos,
explains the evidence, and improves through scored technician confirmations.
Passing unit checks is not a measured recognition improvement.

Review PR12's final original-transport update at the exact head shown in the
PR description and match its validation evidence. Earlier UI/scorer candidate
1d0ad4a is an ancestor. GitHub publication recovered and the prior complete
candidate is on the PR branch. PR11 / build 5338d7a and run
92052f1f-794b-42e8-b33d-462394c29126 remain frozen. Do not rerun, deploy,
merge, change budget accounting or contact others as part of this review.

Changes to inspect:
1. Label-first reader: physical sticker and maker mark remain distinct; model
   boxes cannot come from cast logos; one native crop per call, OCR after reader,
   completed crop evidence retained after a later timeout.
2. docs/catalog/pdq/REVIEW.md: submitted extract is preserved unchanged. Six
   exact legacy rim designations were independently read from PDQ's official
   6200R architectural submittal, page 2. Missing binary hash is null, not invented.
   Current price-book rows are unverified; previous-generation is not a confirmed
   discontinued claim; similar appearance does not prove replacement.
3. catalogIdentityReview.ts links exact model marking and maker mark across
   photo indices of one device. Candidate remains pending technician. Readable
   disagreement produces CONFLICT. Shared trim/cross-reference never supplies
   identity. Classifier DORMA claim remains separate from readable logo evidence.
4. CatalogIdentityEvidence.tsx presents these states/evidence/source page in
   the technician review. Confirm candidate claims remain qualified and shadow
   mode cannot bypass existing technician-known-product acknowledgment.
5. Export v3 preserves explicit final identity, photo identity, label reads,
   catalog review and linked technician confirmations. Read-only query succeeded
   against staging. Check scope and absence of credentials/image bytes.
6. score-field-identities.mjs scores final suggestions against acknowledged
   technician truth and emits misses/proposed reviews. Unacknowledged truth
   stays pending. Raw correct model cannot count when final model is null.
   Exact suffixes matter. Missing logo alone cannot establish a silhouette cause.
   Current confirmation snapshots are not immutable truth history; series needs
   independent truth. No catalog update/training/example admission is implied.

Validation: 187 recognition tests + TypeScript passed before UI/report delta;
Field App build and candidate/conflict rendering checks passed; six scorer
checks passed. Tests are offline/mocked, not recognition results.

Live evidence: one frozen PDQ run, zero linked technician confirmations.
Scorer returned zero scored runs and pending technician acknowledgment. Unknown
reader attempt 5a49154d-52b4-4012-94c5-92bb5ba2e83b still retains $0.624.
The two completed calls total $0.074265 in list-price estimates. About $0.71
remains under the original $2 cap; it is not authorization to bypass unknown cost.

Return concrete defects with file/line, reproduction and goal impact, then a
ready/not-ready verdict for a bounded paid comparison. No headline accuracy.
Next comparison must preserve baseline and distinguish unchanged-copy rerun
from subsequent camera-original run. Actual originals, original transport,
provider accounting, immutable truth/miss storage and held-out measurement
remain open. Acceptance remains PDQ / 6200 / 6200R with supporting evidence,
technician acknowledgment and a recorded score; unchanged held-out Von Duprin
and Yale sets must not become development hints.


Original-transport addition: inspect recognitionOriginals.ts, storage.ts and the
Field App upload path. Check actual object checksum revalidation, exact private
key, actor/tenant/opening scope, order, byte/pixel limits and guarded-preview
admission. Browser original selection requires 3–5 views. Originals are retained
as opening attachments; source IDs belong to a recognition run. Component-photo
attachment and refresh-resumable upload are not claimed. Native crops still
pass through existing outgoing provider preparation. Connected timing/upload
requires validation; 193 offline tests and six scorer tests are not field accuracy.

Latest supplied cost export has no Oct 7 rows. The hourly usage residual is
14,612 input / 123 output, estimated $0.045681 if attributable to the reader.
Do not treat that conditional estimate as a reconciled charge or zero cost.

Deployment follow-up: PR12 now targets release/connected-candidate solely to
qualify for a Netlify preview; it remains unmerged. A source-identical trigger
commit a60fc368 produced deploy 6ac66f086966e40008b505a3, which failed. Local
inspection reproduced a build admission blocker: only PR11's branch was allowed.
The new build guard additionally permits the exact PR12 branch on the same site
and matching staging project. Ten build/runtime guard checks pass, including
wrong site/project/branch and production rejection. Verify the subsequent actual
deploy; the earlier failed deploy is not a usable preview. Netlify visitor SSO
configuration still returns an internal error and readback remains unprotected.

Subsequent verification: deploy 6ac66f7172dde40009ee9653 is ready at 596c3e69.
Unauthenticated requests receive Netlify HTTP 401 edge-access login redirects;
observed hosting protection conflicts with the connector's enriched settings.
The browser screenshot confirms the original 9,547,080-byte selection passes
12 MiB/file and 40 MiB/set. This is selection evidence, not saved-object proof.

Stephan approved increasing the cumulative testing cap to $5 on Oct 7 at
09:28:55 America/Phoenix. Pre-trial $0.588972 remains counted; trial cap becomes
$4.411028. The unknown reader remains $0.624/unknown, with no refund or claimed
reconciliation. The trial stays paused until exact original hashes are verified
and the single comparison is admitted. A guarded-preview Save original photos
without analysis button performs only the existing private reservation/upload/
confirmation flow, reuses the same IDs for Analyze and makes no AI request.
Review selection/opening reset and current upload checks. Production flow remains
unchanged. This does not yet prove the original-file upload succeeds in staging.
