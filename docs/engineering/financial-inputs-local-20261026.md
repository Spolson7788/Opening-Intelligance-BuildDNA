# Explicit provider estimates and facility planning assumptions

Local only. No migration, grant, runtime enablement, hosted data write or deployment.

Provider catalog versions now retain explicit SKU unit (each/pair/set/pack or unknown), installation minutes per that unit, input as-of timestamp and source assumptions. Estimate versions optionally calculate hourly rate times per-unit installation minutes times quantity with exact minor-unit arithmetic. Whole-job fixed/hourly modes remain separate for shared work. Missing price, time, unit, rate, tax or fees remains unknown. No automatic rounding, invented tax/freight or accounting recognition. Provider estimate snapshots are labelled non-binding, not actual quotes.

Facility best-guess budget lines reuse existing immutable scenario versions without requiring an estimate. One selected active component has an explicit total, currency/precision, as-of date, source basis and optional guessed timing. Server binds actor/org and exact target. Retired/decommissioned/foreign targets and duplicate component allocations are rejected. Existing historical snapshots remain readable. No shared-job allocation policy is inferred.

Validation: 13 disposable PGlite commercial/sandbox tests, 3 provider input UI tests and 17 finance/planning UI/export tests. API TypeScript, Field, React Dashboard and Facility Dashboard builds. Independent read-only review found two defects (retired-opening targets and as-of offset roundtrip), fixed with regression tests; no residual actionable finding. Real PostgreSQL concurrency and hosted financial acceptance were not run for this slice. Existing large frontend chunk warnings remain.

Existing private commercial storage integration and financial runtime activation remain held. Purchasing assignments require decisions about assignment/revocation authority, allowed actions/limits/currency and self-approval. No real authority is assigned. Document retention parity is designed separately; current photo implementation has no defined fixed retention duration. Referenced document deletion/holds still need explicit policy. Recognition remains held.

The separately packaged facility-history candidate 524d1b9 remains unchanged and undeployed. This financial delta is a subsequent local candidate; it must not be substituted into that package or its approval scope.
