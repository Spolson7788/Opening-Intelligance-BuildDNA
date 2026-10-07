# PR 11 recognition correction candidate

Scope: C1–C7 from the review of `1ce1ef442bc756bd4e539fdba74bbc37d4b49a46`.
Base: `a970d244f0ee27cff3c35fbbe2a063a83e5db624` (`release/connected-candidate`).
Label and reference prompt versions: `oi-label-reading-11`, `oi-reference-evidence-11`.

## Changes for re-review

- C1: Label candidates use approved/citable reference-document catalog rows. Product names are absent from the candidate, reported-input and conservative-suggestion decision code. Family and exact marking treatment is shared across manufacturers. Catalog associations do not overwrite photograph identity.
- C2: Retrieval uses photo-derived identity/markings only. Technician attributes are retained separately on the run for subsequent scoring/display. Neither retrieval nor comparison uses them. Free-text reported markings are no longer interpreted as a product identifier.
- C3: A run exists before provider work. Every provider request gets a durable started attempt before sending; inability to write this record prevents the call. Provider errors, transport errors, invalid outputs, deadlines, latency, raw output and available usage are recorded. Both stage deadlines and the total deadline reach the underlying fetch through abort signals. Failed primary analysis still retains the label evidence and its provider attempts.
- C4: Partial catalog matches have `model: null`; even a sole partial match cannot be applied through the product button. The original question-mark transcription remains available. A partial-only label cannot support a completed stage-one model.
- C5: The server derives `identity_source` and `identity_value_producer` from stored run evidence and the acknowledged saved value for direct, queued and edited identities. Client producer values are not accepted. The reported-product fallback button was removed. Shadow hypotheses cannot become operational photo provenance; the technician-known-product path remains available.
- C6: Every accepted image is EXIF-normalized with sharp `.rotate()` before crops, regardless of compressed size. Crop-before-explicit-label-rotation behavior remains covered by the existing pixel-exact tests. Original upload hashes remain on the run.
- C7: Per-call request manifests (image hashes rather than duplicate images), raw responses, model IDs, token usage and pricing basis are retained. Runs record sharp/libvips and tesseract.js versions. Per-OCR-view descriptors include source region, crop box and coordinate units, transformation, image hash, raw text, confidence and outcome. OCR evidence is persisted separately before waiting for the AI label reader.

## Boundaries

Both `OI_RECOGNITION_ENABLED=true` and `OI_RECOGNITION_SHADOW_ENABLED=true` are required. Existing comparison flag remains separate. No flags were enabled in hosted environments, no hosted migrations were applied and no recognition provider was called during development/testing.

The additive migration is `20261005000100_recognition_shadow_audit.sql`. Existing provenance is left `unknown` rather than backfilled with invented origins.

`OI_PROVIDER_INPUT_USD_PER_MILLION` and `OI_PROVIDER_OUTPUT_USD_PER_MILLION` supply operator-verified pricing for estimates; each estimate stores its model and rates. Unavailable usage or pricing is explicitly `null` / `unknown`, never zero. Interrupted requests may require reconciliation with provider billing; cancellation cannot retract already billed work. A process interruption after sending leaves a durable `started` attempt rather than no evidence.

No held-out manufacturer/photo trial was run. Synthetic regression tests do not establish recognition accuracy. C8–C12 and direct-save run back-linking remain outside this correction scope. The PR remains draft and requires independent re-review and a separately agreed bounded staging test set.

## Rebase

The original 54 changes were replayed onto the base. Test-config conflicts retain both branches' regressions. The opening-page conflict retains the base's component/opening service-history separation and the PR's purchasing request control. No production branch is updated.

Publication uses one consolidated commit whose parent is the base above, with the same tree as the locally rebased and tested history. The original reviewed head is retained at `archive/pr11-reviewed-1ce1ef4`; this avoids lengthy history replay through the connector when command-line push credentials are unavailable.

Local frozen validation: 565/565 tests across 73 files using PGlite in UTC; API and Field App builds and Dashboard generation passed. The earlier unfrozen run had two timezone-dependent date assertions and one stale-module assertion; the frozen UTC run resolves these without changing application date behavior. Native PostgreSQL CI remains the release gate; consult the checks on the published SHA.
