# Identity-first recognition correction — 2026-10-07

## Goal and measured status

Recognize brand, series and model from grouped photographs of one installed device, retain photo-linked evidence, then score against technician-acknowledged truth. The PDQ development case is human-reported PDQ / 6200 / 6200R. Recognition success has not yet been demonstrated by this correction.

The preceding staging comparison retained the original photographs, completed a locator and one sticker reader, but the reader described no label in its crop. The logo was not read because remaining headroom was insufficient. The run remained running with no completed suggestion. These are saved observations; the precise cause of host interruption is not established by a function log. Both responses are available for review. Do not overwrite the frozen baseline or relabel the interrupted run as a successful recognition.

## Correction

- The locator precedes at most two concurrent identity readers: a product label and a maker mark. Each reader receives one native crop plus bounded context from its own photograph. This lets a reader inspect the source when the locator misses the marking; it does not validate the locator box. Context and crop are the same evidence, never independent corroboration.
- Record source/context hashes, crop metadata and each completed transcription independently. Save the combined label result before optional classification.
- Keep originals intact. Prepare bounded outgoing full-frame views before constructing provider requests to avoid large lossless PNG JSON copies. Native images still supply label crops.
- In the authenticated bounded trial only, skip optional measurement-marker detection and overlapping classifier detail generation. Ordinary classification retains its existing views. Skip late classification rather than discarding label evidence; return a label-only result when classification is unavailable.
- A clear maker transcription plus an exact reviewed catalog model may populate a proposal in the returned manufacturer, series and model fields. The proposal remains pending technician acknowledgment, with null uncalibrated confidence. Missing OCR agreement alone does not erase a cast maker mark. Unsupported pairs, conflicting maker evidence, ambiguous models and incompatible classified component families do not receive this proposal.
- A running record older than 90 seconds is reported as interrupted on authenticated request recovery. This is a read-time diagnosis; it does not rewrite historical rows or issue another provider call.

## Verification and limits

TypeScript check, Field App build and 203 offline assertions across 17 test files pass. Added checks cover concurrent logo reading while a sticker is still pending, independent checkpoints, partial transcription retention, exact catalog proposals and conflicts, identity-only classifier requests, and stale-run recovery boundaries. Mocked reads establish software behavior, not field recognition accuracy.

The actual photographs still require one measured rerun on the deployed correction. A run counts as progress only when saved output and evidence demonstrate improvement. No new paid call, technician confirmation, production merge or production deployment was performed for this correction. Prior unresolved billing remains fully counted. The initial correction did not increase trial run limits. The subsequently authorized comparison adds one explicit build-bound rerun.

## Independent Grok review

Review the implementation and offline results, especially partial evidence under interruption, concurrent budget reservations, source-photo association, proposal versus confirmed identity, and preservation of ordinary classification behavior. Do not initiate recognition, change trial limits, merge or deploy. Then compare the next authorized field result with the frozen baseline, separating correct photo reads, returned identity fields, component classification and technician acknowledgment. Do not count self-reported confidence as accuracy or this development device as a held-out trial.

## Explicit comparison replay

One additional comparison can be granted through a server-side audit authorization bound to the actor, organization, trial, ordered photo hashes, prior run and exact corrected build. Registration retains the locked run counter and cost ledger. The same build cannot use the grant twice; unapproved builds and photo sets fail closed. No retry occurs automatically. The original scope digest and prior run rows are preserved.

Replay guard validation: 32 tests pass in the independent PGlite budget suite. TypeScript and Field App build pass. No paid call is made by granting the comparison.
