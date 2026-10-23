# WP4 acceptance follow-up and bounded WP5/WP6 local slice

Branch: feature/video-facility-workflows. Previous milestone: 2885d58. Backend: 9a607aa. Source: Oct19 engineering plan, Library libfile_76c6ea7336c08191b9d65a8503207913, pages 9-17, read in full for this scope.

## Scope reconciliation
WP5 reuses existing authorized owner scope, immutable provider estimate snapshots and commercial document versions. This slice adds sandbox-only purchase draft revisions, canonical snapshot hashes, transactional append-only draft/review events and a disabled delivery-hold record. New revisions supersede old unsent holds. Explicit constructor injection enables sandbox writes; default runtime is disabled. Existing roles can draft within their owned opening, but acquire no financial approval or dispatch authority.

WP6 reuses active component identity, installation facts, replacement records, unique service event IDs and downtime union calculations. Added an owner-scoped opening projection with server-owned condition reporting method/threshold12, manufacturer/model/type cohorts, explicit unknown installation/exposure, retired exclusion, and immutable single-estimate fiscal scenario references. Material labels are excluded; no aliases/model variants are silently merged. Missing cost is unknown, not zero. Planned references, disabled purchase drafts and unavailable actuals are never summed together.

Actual Facility Dashboard: new planning.html/planning.mjs reached through the commercial screen. No separate React Dashboard implementation or dependencies were substituted.

## Local acceptance and tests
WP4 mobile at390x844: rendered without horizontal overflow (document width375 within viewport390). Expired and missing-price review controls disabled. Missing private evidence rejected by API through the actual screen. Account switch cleared commercial content and unrelated account reload returned not found. The stale retry button visible after account clearing was fixed. No PDF upload was repeated; negative-path fixtures contained deliberately unavailable document IDs and synthetic estimates, not provider proof.

WP5/6 desktop and mobile browser: created a purchase draft, requested sandbox review, observed Delivery disabled / Financial approval unavailable / Issued no; created revision2 and observed revision1 delivery hold superseded with historical review retained; created FY2027 scenario from missing-price estimate and observed unknown total and tax coverage gap. Audit actor/version/event IDs rendered. Mobile390x844 had no horizontal overflow. Browser fixture server only127.0.0.1, disposable PGlite, no real recipient or external transport.

13 focused tests passed in final runs: planningSandbox4; commercialVersions6; commercialClient/commercialUi3. API typecheck, actual Facility Dashboard build, module syntax and git whitespace checks passed. Initial combined PGlite-file run failed due to connection lifecycle across files; final API files ran separately on fresh disposable PGlite instances with a single connection. This is explicitly not real PostgreSQL concurrency acceptance.

New tests cover default-disabled writes, tenant denial, actor/payload-bound retry, stale revision conflicts, canonical hash matching serialized stored JSON, immutable version protection, transactional review/disabled hold, supersession, missing amounts, server-required scenario fiscal period, current source-quote supersession, unknown actuals/exposure, two-part/11/12 threshold boundary, unverified/retired/material exclusion and separate models.

Independent read-only review found three issues, all fixed and re-reviewed: source-estimate supersession hidden in history; missing server fiscal-period validation; removed DOM form dereferenced during account-change cleanup. Tests additionally found timestamp normalization was required before hashing; fixed and hash test passed. Reviewer reported no remaining blocker in the bounded code scope, without independent test or concurrency claims.

## Intentionally incomplete packages and decisions
This is WP5/WP6 foundation, not completion of their Oct19 exit criteria. No financial approval, official PO number/PDF, verified contact registry, transport worker, issued state, acknowledgement, callbacks or real dispatch exists. Disabled holds cannot send anything. Full approved PDF/hash equivalence, simultaneous workers, unknown-send reconciliation, bounce/ack differentiation and issued amendments remain future acceptance.

Product/configuration decisions needed before approval: named purchasing approvers, amount/currency limits, self-approval policy, verified recipient relationship, approved terms/service address, and accounting/invoice recognition policy. They are explicit gaps, not invented defaults. Drafting requests are not financial approvals and do not bypass existing purchasing gates.

WP6 remaining independent implementation: multi-intervention facility scenarios, explicit low/base/high and inflation/contingency assumptions, historical condition observations/recency, source-aware quoted versus budgetary classification, manufacturer alias review, fiscal rollups/export, accepted invoices/credits/cancellations and partial actual/commitment reconciliation. Existing current-condition portal chart remains unchanged; this new projection is opening-scoped. No claim of complete cost coverage, statistical reliability, exposure-adjusted performance or remaining useful life. Histories lack pagination in this bounded slice.

Existing release gaps remain: no real local PostgreSQL available, no hosted runtime acceptance, production private immutable storage adapter unconfigured, no physical printer/phone evidence and separate React Dashboard dependencies unavailable. Existing Oct20 recovery tests/fixtures untouched. No installs, push, deploy, hosted schema/grants, credentials, permissions, live data, external notification or recognition work.

## Deliverables
Patch covers 2885d58 through the final UI/report commit. Local browser evidence lives in task/acceptance-evidence/wp4-mobile-negative.png and wp56-mobile-scenario.png. No screenshot is uploaded to Library.

Library export limitation: current Library skill requires its Python prepared-upload helper for a multi-file report/patch batch. Current helpers were obtained, but python/python3/py/uv are not available on PATH, and the workspace dependency resolver returned unsupported for this thread. No installation or alternate upload bypass was attempted. Local files are complete and can be uploaded by the parent in an environment supporting the required helper. No Library upload was started; outcome pending, not uncertain.
