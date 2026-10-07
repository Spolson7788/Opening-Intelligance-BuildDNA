# PR 11: named fixes after b9d9e887 re-review

Review baseline: `b9d9e887d855fceffa875022eb8c1d5f7c16f566`.
Release base: `a970d244f0ee27cff3c35fbbe2a063a83e5db624`, already an ancestor.
This change does not authorize a shadow trial or production deployment.

## Corrections

- **B1:** EXIF-normalized, full-resolution PNGs remain local crop sources. Each
  outgoing provider view is independently JPEG-encoded at at most 1,568 pixels
  on its long edge, without enlargement. The shared audited provider boundary
  enforces a 1 MB encoded-image ceiling and a 24 MB complete JSON request ceiling;
  it lowers quality/resolution as necessary, or refuses the request. The image
  allowance also accounts for image count and base64 expansion. Local tesseract.js
  input does not go through this provider conversion. Label/model-line processing
  no longer shrinks native crops; small-crop OCR enlargement remains available.
  The audit records input/output hashes, dimensions, orientation, encoding,
  quality, byte count and preprocessing version for every outgoing image.
- **B2 / remaining C1:** Product-specific geometry facts moved to
  `src/data/installationGeometryCatalog.json`. Matching uses each catalog entry's
  intervals. Sources require approved documents, citable verified pages and
  corresponding model associations. Only candidates with actual compatible
  geometry can trigger fallback retrieval. No-landmark and nonmatching cases
  contribute no candidates. Shared geometry still cannot establish identity.
- **F1:** Both token counts must be nonnegative safe integers and pricing must
  be finite and positive before calculating an estimate. An unavailable or
  nonfinite estimate is null/unknown; raw usage remains recorded.
- **F2:** Missing audit context rejects before fetching. Failure to persist a
  started attempt also continues to prevent provider calls.
- **Audit gaps:** Model-line transformations include their source rotation.
  Primary 502 failure status and safe error category are retained on the run.

Versions: `oi-label-reading-12`, `oi-installation-geometry-2`,
`oi-provider-image-1`. Reference prompt remains `oi-reference-evidence-11`.

## Provider limit basis

Anthropic's current vision documentation distinguishes standard resolution
(1,568-pixel long edge, also constrained by visual-token budget) from higher
resolution models. Existing model selection remains unchanged. This patch uses
1,568 as a conservative outgoing cap; it does not claim that the provider cannot
further resize an image to its token budget. All crops precede this conversion.

Source checked for this change:
https://platform.claude.com/docs/en/build-with-claude/vision

## Regression evidence

`tests/providerImageBudget.test.ts` exercises oriented 12 MP phone JPEGs and the
actual audited outgoing payload. Its full-resolution regression calls the real
label-reading pipeline with mocked OCR/provider services. It compares native
crop pixels, verifies the OCR input contains the expected model-line pixels,
checks source hashes and retained native dimensions in provider manifests, and
shows whole-photo downsampling cannot reproduce that detail. These are synthetic
processing tests, not recognition-accuracy evidence.

`tests/referenceEvidence.test.ts` seeds an approved geometry catalog document
and verifies a Norton closer with no geometry cannot retrieve its LCN page or
start a comparison. Geometry unit tests also exercise a different synthetic
catalog pattern. Audit tests cover incomplete/invalid usage, missing context,
provider failure, aborts, durable attempt creation and saved 502 errors.

## Trial remains held

No paid recognition requests, hosted migrations, production deployments or
hosted flag changes were made. Mocked providers are used for automated tests.
Both recognition enablement and shadow enablement flags remain required.
Preserve the technician-known-product workflow.

For a later authorized trial: use acknowledged technician identities as ground
truth; verify joins via `identity_recognition_run_id`; exclude the layout-tuned
photo; hide AI output from technicians or record exposure. C8/C9/C12 accuracy
issues, missing scale-marker same-plane context, short numeric model matching,
and direct-save linkage remain limitations. No held-out real-photo accuracy
claim is made.

## Local validation

- Full suite through the local PGlite harness: 578/578 tests, 74 files.
- Release configuration: 143/143 tests, 11 files.
- Offline configuration: 127/127 tests, 21 files.
- API TypeScript build, Field App production build, Facility Dashboard generation
  and dashboard JavaScript syntax check: passed.
- The final version-constant bookkeeping change is checked again by the targeted
  recognition API tests and TypeScript. Native PostgreSQL validation is delegated
  to both required GitHub CI workflows on the published commit.
