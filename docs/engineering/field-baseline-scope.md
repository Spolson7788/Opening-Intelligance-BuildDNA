# Frozen multi-view field baseline

Parent recognition implementation: 103f8b8a67380f1a14e39343bb03f0b2d0a04f45.
This patch changes only trial admission and records the admitted input-set index.
Classifier, locator, reader, reread, reference prompts, catalog and client are
unchanged so the baseline measures the current implementation.

Optional approved_photo_sets binds three to five distinct original-photo hashes
per case, in a fixed order. photo_sha256 is the SHA-256 of JSON.stringify of the
complete array of approved sets. A matching user, organization and QA opening
remain required. Each complete set is admitted once, under one shared trial cap.
Mixed, reordered, incomplete, duplicate and extra-photo sets fail closed.
Legacy single-photo trials remain unchanged. Unknown spend still pauses the
trial; the conservative provider ceiling and settlement rules remain unchanged.

Three field cases comprise 12 original photographs. Separate trim views are
excluded. Source bytes, scope manifest and outputs stay private, outside git.
No manufacturer/model answers enter the trial admission record or AI prompt.
These are exploratory baseline cases, not a completed held-out accuracy trial.
The existing QA opening is test context, not a claim that all photographed
hardware belongs to the same installed opening. No hardware identities or
purchasing records should be saved as part of this experiment.

The new allowance must be the remaining amount under the original aggregate
$2 authorization, subtracting settled and reserved costs of all previous trials.
Do not open this trial until the preview build, actor, scope and provider account
headroom are verified. Stop after three cases, any unknown settlement or a
provider account-limit rejection. No automatic retries.
