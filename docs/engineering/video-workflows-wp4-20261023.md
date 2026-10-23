# WP4 local implementation and validation

Scope: provider catalog and document versions, immutable replacement estimate snapshots and historical verified review in the actual Facility Dashboard. Branch feature/video-facility-workflows; prior package aad59ce; backend commit 8b6848f. No push, deployment, hosted migration, permission expansion, external delivery or PO issuance.

## Reused and added
Reused tenant/provider assignment authorization, existing admin/manager roles, component identities and paired leaves, whole-opening completion and purchasing approval gates. Added private immutable document adapter contract with server SHA-256/size/read-back verification, append-only catalog/document/estimate versions, actor/payload-bound retry receipts, exact integer minor-unit calculation, explicit missing prices and expiry, historical review records, and warranty evidence links to verified facility document versions. The default production app has no storage adapter and fails closed; the in-memory adapter is injected only into local tests.

Actual /facility-dashboard/commercial.html is linked from opening detail. It supports document, catalog and estimate creation/version history, paired component selection, fixed or hourly labor, quoted taxes/fees, explicit currency precision, expiry and owner review. Field lifecycle can link a verified warranty document version. Existing public/client-trusted technical URLs are not used as confidential financial storage.

## Verification
26 focused tests passed: six PGlite commercial/API tests, three isolated client/DOM tests, seven existing bulk-import tests, five lifecycle API tests and five installation/time UI tests. API and Field type checks, Field build, Facility Dashboard build, JavaScript syntax and git whitespace checks passed.

Tests cover same SKU across providers, changed bytes creating a new version, missing/corrupt storage rejection, tenant/revocation denial, immutable older quote prices, missing totals, stale/superseded estimates, exact labor arithmetic, stable review retries and changed payload rejection, existing purchasing gates, verified warranty linkage, account switch during response parsing and different submissions during pending retries.

Independent read-only review identified and verified fixes for replay payload binding, preservation of purchasing gates, account changes during body parsing, pending submission confusion, and bulk-import serialization with opening review. No remaining blocker was reported in that bounded review. This is not real PostgreSQL concurrency evidence.

## Browser acceptance
Using Edge and only the disposable localhost:4183 fixture, observed a saved synthetic 112-byte document version; created provider SKU version 1 at 1234 USD minor units; created an estimate targeting the inactive paired leaf with quantity 2, hourly labor 9000 x 90/60, tax 200 and fees 300. Total was exactly 16468 minor units. Created catalog version 2 at 9999; the earlier estimate retained version 1 and total 16468. Signed in as synthetic facility owner and recorded the verified review; history displayed yes and the UI stated nothing was ordered or sent. Desktop screenshot: ../acceptance-evidence/wp4-reviewed-estimate.png relative to the task root.

File upload approval manager:e6239bf686684c01aa9bd9decc1fc120:1 concerned .local/synthetic-cut-sheet.pdf to this local app. Parent's forwarding message was not treated as approval. The long-running browser call returned, and subsequent read-only UI evidence confirmed the version was saved. An earlier empty-picker observation reflected form reset and was corrected. The upload was not retried; approval bookkeeping remains unresolved from this agent's perspective, but execution outcome is confirmed. No additional upload is needed for the completed scenario.

## Remaining acceptance and integration limits
- No real local PostgreSQL instance available; locks/concurrent connections require real PostgreSQL acceptance. PGlite and mocked tests do not establish that.
- Private production storage adapter, immutable object enforcement and hosted end-to-end acceptance remain unconfigured/unverified. Default behavior denies document upload/verified use without the adapter.
- Separate React Dashboard dependencies remain unavailable. This package targets actual Facility Dashboard plus existing Field lifecycle screen.
- Mobile WP4 visual acceptance, browser missing-price/expired/revocation paths and browser warranty-upload linkage remain unperformed; relevant API/DOM coverage exists, but it is not a substitute for those browser scenarios. Prior packages' mobile evidence is not claimed for WP4.
- PDF only, maximum 2 MB; histories currently unpaginated. Currency code and minor-unit precision are explicit inputs, not an authoritative currency registry. No FX, tax policy, automatic rounding policy, warranty coverage inference or PO policy is invented. Fractional minor-unit hourly labor requires an explicit fixed amount.
- Document hash verification establishes byte identity and private storage integrity, not professional correctness or warranty coverage. Historical reviews require revalidation before subsequent purchasing steps.

The broader video program and recognition are not complete. Further PO/invoice/budget packages require their grounded package scope; no actual purchasing channel was implemented.
