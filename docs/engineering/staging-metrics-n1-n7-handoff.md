# Grok review handoff — trial metric safeguards N1–N7

Baseline: PR 11 staging commit 1c3c33fd1b45dbc4ddff03fac6fb64f47f14bb7a (P1–P3).
Scope: staging only; no paid analysis, hosted migration, production merge or production deployment.

## Implemented

- N1/N7: every established identity requires acknowledgement at create/sync validation. Status-only PATCH promotion requires acknowledgement; changed identity fields invalidate prior acknowledgement and reset identity/review. Unchanged valid acknowledgements survive nonidentity edits. Purchasing excludes unknown sources and missing acknowledgement metadata, including historical established records. Edit Hardware disables Established until acknowledged.
- N2: literal catalog matching rejects one-character identifiers and pure integers shorter than three digits. Hyphen/underscore token boundaries prevent matching the tail of SIZE 1-980. This intentionally excludes model 98/99 from automatic exact-text matching; technician-known-product entry remains available. Context-aware support for short models is future work.
- N3: conservative manufacturer/series/model gating now runs before retrieval and comparison. Classifier identities remain in photograph_identity audit data, while unsupported suggestion fields are null. Catalog candidates remain separately scoped hypotheses for retrieval.
- N4: catalog resolution no longer receives the classifier brand. A fabricated RYOBI classifier identity cannot filter out an LCN label candidate.
- N5: partial candidates retain catalog_model as hypothesis metadata, separate from model:null. Deduplication and candidate retrieval preserve distinct matching products. The UI lists them without promoting partial markings into transcriptions.
- N6: classifier-only identity after label timeout cannot drive stage two. Separately evidenced geometry may still support comparison; this is not a blanket timeout shutdown.

## Review focus and limits

Inspect POST/PATCH/offline acknowledgement invariants, legacy unknown-source purchasing, retrieval after hallucinated brand, and partial ambiguity retention. No new accuracy claim. Installed 3.png remains a development regression case.

Existing saved runs are not rewritten. Optional refused-request reason, 503 persistence, and blank-threshold collision audit work remains open. Localization and broader confidence presentation remain unvalidated.

The full local PGlite run was interrupted after fixture-related and date-related failures; do not claim full-suite success. Positive established-identity fixtures now explicitly acknowledge their identities, while unknown identities remain unresolved. Targeted test results accompany delivery.

Grok's BUG_HUNT_1dae7a7b.md was not present here; work used the pasted findings and source inspection.

## Validation

- Recognition release suite: 151/151 tests passed across 11 files.
- Focused recognition/identity database suites: 52/52 passed.
- Final affected database suites, run with TZ=UTC: 86/86 passed across hardware, offline sync, paired openings, provider purchasing, technician identity, and reference evidence.
- API TypeScript build and Field App production build passed.
- git diff --check passed. AI responses were mocked; no paid provider calls.

These checks establish regression coverage, not field accuracy or full-suite completion. Re-review the new boundaries before counting candidate/conflict/established metrics as validated.
