# Label validator correction after the installed-image trial

The closed trial on 8f06d444 made ten attempts, nine finished the top-level
analysis, and only one completed label processing. Eight valid JSON replies
were discarded by the application validator. This is not an eight-run model
failure rate, and zero candidates is not a measure of model candidate accuracy.
Classification and abstention repeated on this single image only.

Actual stored replies were recovered and replayed without provider calls.
Runs 1–7 omit indices 1 and 2; runs 2 and 3 also omit index 5. They contain
nonempty text at valid indices. Run 10 includes six valid entries and an extra
index 6; that one entry caused all six valid entries to be discarded.
The accepted and discarded transcriptions include 1040XP, 1C40X? and 1C40?XP.
These remain unconfirmed readings, not product identities. No corrected
end-to-end candidate or accuracy result is claimed by the parser replay.

The correction retains valid entries, records absent crops as not_returned,
records bad entries with reasons, and discards both entries for an ambiguous
duplicate index. Empty text remains distinct from missing text. Both first-pass
and focused reread prompts state the exact expected indices and require an empty
string for unreadable crops. Partial validation remains partial in stage outcomes.
JSON/envelope, refusal and truncation rejection remain unchanged.

The API handler accepts absent test context with optional access while the
deploy-preview staging and spend guards retain their restrictions. OCR wording
claims a conflict only when conflicting model tokens were recorded.

Use scripts/reference/export-stability-trial.sql to export complete run and
provider-attempt records, including raw_output, request_manifest, usage, costs,
timestamps and latency. Existing records did not persist HTTP status or build
SHA per run: historical exports must leave these unknown and identify any
external deployment attribution separately. New runs record build SHA and
prompt/validator versions in recognition_versions, and HTTP status in per-call
provider_http_<attempt UUID> evidence. Build stamping occurs before the Netlify
bundle is compiled. Per-crop locator and OCR evidence remains in stage_one;
raw reader replies preserve proposed label boxes and text rotations.

No paid replay, trial reopening, automatic unknown-cost refund, production
deployment or promotion is part of this correction. A fresh live trial still
requires verified build, identical input bytes, a verified provider account
limit and a new scoped run allowance within the agreed total budget. The
proposed stop rule is three consecutive reader validation failures, including
partial validation. Held-out images follow only after that trial is reviewed.
