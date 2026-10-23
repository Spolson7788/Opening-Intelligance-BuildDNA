# Consolidated local video-workflow candidate

Branch: feature/video-facility-workflows, based on tested ce40fa8. Scope is the Oct19 engineering plan and subsequent authorized bounded packages. Recognition has not started. This is a local review candidate, not production acceptance or completion of every video requirement.

## Requirement disposition

| Requirement | Disposition |
| --- | --- |
| Revision/retry prerequisites, canonical label reprint/batch readiness, component requests | Implemented and locally tested in WP1/2; prior reports retain individual evidence and limits. |
| Installation certainty/source, append-only corrections, replacement identity, current-component projections, downtime and warranty records | Implemented and locally tested in WP3. No inferred warranty coverage or historical dates. |
| Provider catalog/document/estimate versions and verified private document metadata | Implemented and locally tested in WP4. Production private storage adapter remains unconfigured and fails closed. |
| Purchasing draft revisions, snapshot/hash/audit and disabled delivery holds | Sandbox implementation and local acceptance in WP5; actual approval, issuance and delivery remain unavailable. |
| Descriptive condition/lifecycle planning, versioned budget scenarios | Implemented locally. Latest slice supports multiple fiscal-period intervention lines, explicit low/base/high amounts and contingency assumptions; nonreplacement base is explicit or unknown. |
| Invoice/credit/partial-payment evidence reconciliation | Latest sandbox model/API and actual Facility Dashboard UI implemented and tested. Evidence is distinct from accounting recognition or executed payment. |
| Purchasing authority limits, self-approval, commercial terms, accounting recognition, cancellations/refunds | Product/policy decisions remain unresolved; no values or authority invented. |
| Hosted migration/storage/provider integration, real PostgreSQL concurrency, physical label/phone scan | Not performed; outside this local acceptance. |

## Final finance slice

Immutable scenario versions preserve estimate snapshots, currency precision, assumptions and hashes. Duplicate component allocations and mixed currencies are rejected. Source estimates can be visibly stale without rewriting old scenarios. Unknown amounts remain unknown. Existing-scenario editing retains explicit inspection/repair/defer base costs.

Append-only invoice, credit and payment-evidence records preserve correction history and tenant/provider/estimate allocation. Retry payloads bind to the actor. Invoice identity is unique per provider; credit/payment references cannot be reused across invoices for that provider. Verified private document versions are checked when supplied; missing evidence stays visibly unverified. Reconciliation uses current correction heads and exact integer arithmetic: invoice minus credits, then minus payment evidence. Forecasts, commitments, invoices and payments are never added into a misleading combined total. Excess credits/payments and disputes remain exceptions rather than being silently clamped.

The financial routes require the explicit local sandbox flag and existing write roles. No financial authority expansion, commitment, payment execution, real PO or external delivery is introduced.

## Verification

- Final serial disposable PGlite runs: sandboxFinance 4, commercialVersions 6, planningSandbox 4, commercialClient 2: **16 passed**. These are not real PostgreSQL concurrency tests.
- TypeScript noEmit, finance module syntax, Facility Dashboard build and git diff whitespace check passed.
- A direct client-test invocation initially failed global setup because no PostgreSQL service was listening at localhost:5432. Rerunning through the existing disposable PGlite harness passed both client tests; no installation or hosted fallback used.
- Independent read-only review found and prompted fixes for duplicate cross-invoice payment references, inappropriate replacement-quote defaults for other interventions, and dropped intervention bases on scenario revisions. Final reviewer found no unresolved demonstrated blocker; reviewer did not independently rerun tests.
- Actual local Facility Dashboard browser acceptance: inspect scenario 40/50/60 saved as v1 then v2 with identical snapshot hash; invoice 1000, credit 200, payment evidence 500 rendered net invoice 800 and unpaid difference 300, with unverified-source warning and no-payment-executed text.
- Desktop and 390x844 viewport screenshots saved under ../acceptance-evidence/finance-reconciliation-{desktop,mobile}.png. Mobile document/client width both 375 pixels, with no horizontal overflow. Temporary viewport override reset.

## Remaining limits and delivery

The accounting UI is online-only sandbox evidence entry. Split allocation of one payment across invoices, reassignment of an existing invoice's budget allocation, refunds/cancellations, accounting recognition, reservations/commitments and actual financial approval are not implemented. No currency conversion or cross-currency grand total is implied. Budget scenarios require existing estimate versions and do not claim a complete enterprise forecasting engine or validated reliability/exposure model. Separate React Dashboard acceptance/dependencies remain outside this actual Facility Dashboard package.

The command-service interruption recovered; saved work was preserved and final checks resumed on the same branch. No push, deployment, hosted schema change, software installation or real notification occurred. Earlier native Library uploads succeeded through an earlier available path; that does not establish a Python runtime. Current required Library preparation cannot run because Python/python3/py/uv are unavailable and dependency resolution did not support this thread. No upload retry or bypass was attempted. Report and patches are local, with commit IDs provided in the thread.
