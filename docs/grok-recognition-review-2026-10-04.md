# Grok recognition review reconciliation

Reviewed baseline: `170522af70f009024b9733df67a030942df3a3d9`.

Unknown-product recognition remains held from field trial. The technician-entered
identity path is not yet cleared: saved hardware identity provenance is still needed.
The user reports raising the Anthropic API spending limit; no paid call was made
to verify restoration during this correction batch.

## First correction batch

- Model-line extraction now materializes original-coordinate pixels before Sharp
  rotation. Regression fixtures use spatially distinct pixels at 90, 180 and 270
  degrees, so a misplaced crop cannot pass as a dimensions-only check.
- Visual classification no longer receives technician attributes. Reference
  comparison no longer receives the raw technician-attribute object. Reported
  identities remain separate retrieval hints; choosing documents using those hints
  does not independently confirm identity.
- Named model-completion examples were removed from the label transcription
  prompt. The baseline actually said **do not** turn a partial marking into a
  specific model; Grok's statement that it instructed expansion was incorrect.
  Other pilot model-specific rules remain and must be replaced with catalog-driven
  matching in the next batch.
- Conflicting OCR model readings no longer discard the visual candidate. Raw
  readings are preserved and conflicting model tokens are displayed for technician
  review. This does not turn the retained candidate into verified identity.
- The full API workflow now includes pull requests into
  `release/connected-candidate`. Previously a separate candidate workflow ran
  targeted native PostgreSQL, recognition, access, and build checks on branch
  pushes; the full suite was indeed limited to PRs into `main`.
- Label reader version is `oi-label-reading-8`.

## Remaining corrections and validation

1. Persist hardware identity source and acknowledgment across direct save, offline
   synchronization, editing, and Dashboard presentation. Preserve run linkage when
   a suggestion is used and distinguish subsequent technician corrections.
2. Replace the LCN-specific label candidate logic with approved catalog matching,
   including Cal-Royal and exit-device families; retain partial and conflicting
   hypotheses without completing the photographed text.
3. Record failed recognition attempts and provider usage independently of the
   successful recognition result. Cover paid calls completed before another stage
   fails, cancellation, malformed replies, and billing reconciliation.
4. Restrict the geometry pilot fallback to demonstrated candidate evidence and
   show the reference comparison's coverage. Retrieval and a valid citation do
   not by themselves prove a match.
5. Verify actual deployed identity, approved reference records, and the full API
   suite, then run a separately bounded real-image evaluation. Mocked calls and
   synthetic pixel fixtures are not field accuracy evidence.

Grok's reported OCR counts are review evidence supplied by Grok, not independently
reproduced OS results. No measured recognition accuracy, latency, or per-opening
cost is asserted here.
