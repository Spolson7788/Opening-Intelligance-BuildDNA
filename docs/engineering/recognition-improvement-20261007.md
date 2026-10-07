# Goal and measured status

OI must establish brand, series and model from grouped real field photos at
the highest defensible level, explain the evidence and learn from technician
confirmed results. Engineering checks are prerequisites, not recognition gains.

Frozen baseline: run 92052f1f-794b-42e8-b33d-462394c29126, build
5338d7a11e2392ace5f33a3cbf4ec7193ea5d4cf. Three ordered PDQ copies were
submitted together. Final manufacturer/model/series were null; raw classifier
said DORMA and 6200R; label reader timed out. Human inspection sees PDQ and
Model 6200R. Technician acknowledgment in the app remains pending. Preserve
the run unchanged. No accuracy percentage or confirmed example is established.

The submitted copies retain visible logo/model evidence. Compression may affect
recognition but was not experimentally isolated as the cause. The baseline
reader request contained eleven derived image views; these are not eleven
independent photos. A response absent because of timeout cannot be replayed.

# Candidate in this change

Only guarded trials use the new targeted reader. Labels precede the broad
classifier within the existing 49-second overall cap. The label pipeline has a
32-second allocation; classifier has its own remaining-time bounded allocation.
Provider calls remain sequential under the unchanged spending guard.

Locator distinguishes physical product labels from cast/embossed brand marks.
Brand marks cannot provide model-line boxes. Select one label, one maker mark
and at most one additional label, independent of development photo order or
expected manufacturer/model. Read native source crops before enhancement,
model-line variants, fallback tiles and OCR setup. Send one crop per reader call.
Do not start a reader with less than twelve seconds of headroom. Record source
and crop hashes/boxes and persist each completed crop before continuing.

OCR runs afterward and never fabricates independent agreement for cast logos.
Valid completed transcriptions survive failure of a later crop. Every received
provider reply still uses the existing raw-output audit. Transport interruptions
retain unknown-cost treatment; never invent missing output or zero cost.

This changes scheduling and first-pass crop selection, not proven recognition.
The locator still needs source-pixel review. This candidate does not implement
full-original upload, final identity promotion or automatic feedback-driven updates.

Catalog update: reviewed official legacy PDQ rim designations are now available
as candidate facts. Guarded exit-device trials attach catalog_identity_review,
with exact model and maker-mark evidence grouped across photo indices. AI-only
reads remain pending technician confirmation. Conflicting readable maker marks
remain CONFLICT; classifier claims stay separate. The supplied current-product
extract is preserved for review, but unsupported lifecycle/supersession claims
and unverified price-book rows are not admitted. See docs/catalog/pdq/REVIEW.md.
No PDQ expected strings or development-photo indices enter the reader prompts.

# Next gates tied to the goal

1. Full-resolution transport: camera originals shown on the technician computer
   total 9,547,080 bytes; copies available here total 1,437,699 bytes. Both the
   recognition JSON path and private-photo storage currently have 2 MB limits.
   Add a bounded direct-to-private-storage original input path with source hashes
   and authorization; raising UI limits or shrinking every original is insufficient.
2. Retrieve actual three camera originals and preserve them as a different input
   version. Use an unchanged-copy rerun to isolate the reader change; a subsequent
   original-photo run also changes image input and cannot isolate code improvement.
3. Reconcile timeout attempt 5a49154d-52b4-4012-94c5-92bb5ba2e83b from provider
   account evidence. Keep $0.624 reservation until supported reconciliation.
   Trial remains paused. About $0.71 is unallocated under the original $2 cap;
   this is not permission to run while any cost is unknown.
4. Reviewed official catalog extract: PDQ 6200/6200R and current 6300/6400,
   manufacturer source URL/document hash/page, observed model spelling, family,
   lifecycle status and source, plus separate accessory/compatibility relations.
   A catalog-supported pair is a candidate pending technician review. Absence
   from an incomplete catalog is not proof the maker never made the model.
5. Link technician acknowledgment to frozen run, score final brand/series/model,
   keep wrong raw brand versus suppressed final identity distinct, add a miss
   queue and verified examples. Merely storing confirmation is not learning.
6. Measure this case on the changed build; preserve untouched Von Duprin/Yale
   examples for evaluation after accounting is unblocked. At least 20–30
   confirmed devices are required by this protocol before an accuracy figure.

Acceptance remains final PDQ / 6200 / 6200R with per-photo evidence, a supported
catalog candidate check, technician review and a scored result. No production
deployment, provider payment or rerun is part of this draft change.


# Review, export and scoring continuation

Candidate UI now displays catalog review states, per-photo maker/model evidence,
source page and classifier estimate separately. Existing shadow-mode purchasing
and identity-confirmation restrictions remain in force. Trial export v3 adds
explicit identity-review records and linked technician acknowledgments.

`node scripts/reference/score-field-identities.mjs export.json` automatically
uses acknowledged, established installed-hardware identities from the export.
It produces final-output brand/model counts and a miss queue. Series remains
unscored unless independently recorded in a supplied truth JSON. Acknowledgment
alone is not a verified product specification; technician truth remains the
benchmark's declared ground truth. Conflicting confirmations fail rather than
selecting one silently. Exported confirmations are current snapshots, not an
immutable historical truth table. Automated truth storage and miss-resolution
remain further work.

An optional independent truth JSON can supply series, development/held-out split,
logo readability and human-reviewed brand basis. The scorer does not infer a
silhouette cause merely from a missing logo. Accuracy figures require at least
20 distinct held-out devices with one scored run each. No catalog updates or
confirmed-example admission happen automatically.

Read-only staging check on 2026-10-07: frozen PDQ export has one run and zero
linked technician confirmations. Scorer returns pending acknowledgment, zero
scored runs and no accuracy figure. Existing unknown reservation remains
$0.624; completed estimates are $0.055041 and $0.019224. No paid run occurred.

Validation: Field App production build passed; candidate/conflict UI rendering
checks passed; six offline scorer tests passed. Prior recognition suite remains
187 tests. This continuation did not alter provider scheduling or reader code.


# Original-photo transport candidate

Guarded deploy previews can reserve/verify originals through the existing private
photo protocol (12 MiB per image). The recognition body contains ordered photo
IDs, not base64 originals. Three to five same-format views are required, with
40 MiB combined and 48 million decoded pixels per set. The staging private
bucket already has a 25 MiB object ceiling; no bucket configuration was changed.

API checks each source belongs to the current actor/organization/opening, is
verified, and has the exact expected private storage key. It retrieves bounded
bytes from server-configured storage, rechecks the actual checksum, records
original hashes/photo IDs and then normalizes EXIF. Native originals enter
local crop selection; outgoing provider views still use existing resize limits.
Original retrieval/local preparation count against the reader's time budget.
Do not claim this prevents all timeouts; connected timing needs measurement.

Ordinary/production media limits remain 2 MiB. Large-image storage is admitted
only by the existing trusted deploy-preview stability runtime. Selected originals
are opening attachments, not yet attached to a newly saved hardware component;
run source IDs preserve their grouped relationship. They are not sent a second
time through the component's legacy 2 MiB photo queue. Browser refresh during
upload is not yet a resumable original-recognition operation. Existing reservation
and confirmation checks apply, but partial successful uploads may require review.

Validation: 193 offline recognition/transport checks, six scorer checks, root
TypeScript and Field App build passed. Native-byte retrieval is mocked; six
new checks cover ordering, actor/tenant/opening isolation, forged storage keys,
per-image/set limits, object mutation/checksum, and production size guard.
No paid recognition rerun or camera-original connected test is established.

Provider CSV review: Oct 7 hourly usage is 35,907 input / 815 output. Known two
calls account for 21,295 / 692. Residual 14,612 / 123 is consistent with the
interrupted reader, estimated $0.045681 at the existing rates. The Cost CSV
contains Oct 3–6 only, not Oct 7. It does not reconcile the interrupted charge.
Unknown $0.624 reservation remains; trial stays paused.
