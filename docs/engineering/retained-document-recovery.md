# One retained synthetic PDF: metadata recovery proposal

Preparation only. No hosted metadata recovery or deployment authorized by this document.

Live baseline: ce1bc72 / deploy 6adfe624aa247615a57fb5c0. Existing object in private oi-video-workflows-media: commercial-documents/v1/ca665af9-a08b-423d-97ef-a90ecdee95f5.pdf. PDF, 664 bytes, SHA256 95c299eb61a9ac6c417e5b14ef54479f03c9666d7bee77fd80e9d57b90daef00. Full hosted read/hash verification passed after the separately approved two-policy correction. Six photos, two condition observations and this PDF are preserved. Documents, versions, SKUs, estimates and budget versions remain zero.

## Provenance limits

The upload's technical Storage owner is not an application actor. Admin A is the verified current recovery actor, not a retrospectively reconstructed original request. The original series ID, exact title/kind and request hash were never committed and the client payload is unavailable. The local synthetic PDF fixture proves bytes, not those lost metadata fields. Do not reconstruct an original timestamp or claim provider assignment coverage.

Proposed new metadata uses a clearly labeled recovery title, kind technical, property null, exact Admin A/org, and current server recorded/verified timestamps. New recovery series ID deliberately equals the retained version UUID in a different table namespace; it is not claimed to be the lost series. The original object/version UUID is reused. No separate operation ID exists in this API; fixed version identity and canonical recovery request hash provide idempotency.

## Application path and constraints

POST /api/commercial/documents/recover-retained-staging accepts only an empty object. Existing current-session authentication and role middleware apply. It additionally requires the exact Admin A user/org/admin role, exact staging site and production context, existing commercial-input capability, configured private store, and explicit OI_RETAINED_DOCUMENT_ENABLED/START/END with a maximum 15-minute absolute window. The existing adapter fixes the project, private bucket, PDF prefix, MIME and size bounds; no caller can supply a path, URL, bytes or identity.

The operation acquires a transaction advisory lock, reads the retained object using the existing technical identity, verifies PDF signature/664-byte size/exact hash, and creates precisely one commercial_documents row with head_version 1 plus one commercial_document_versions row. Existing matching recovery returns an idempotent result; any conflicting metadata fails closed. All failures roll back metadata. No storage create, overwrite or delete method is called. No schema, grant or policy change is required. A commercial-page button is shown only to the eligible actor during the enabled window. No automatic invocation or retry.

Remove the three activation settings after success/failure. The deployed snapshot independently expires at the absolute end time; removing environment values alone must not be represented as disabling an already published snapshot. Route code can remain dormant and fixed-object, with expiry and database uniqueness preventing broader adoption. If code removal is desired, that requires a separate cleanup publication and its cost; it is not technically necessary for expiry.

## Bounded approval and acceptance

Approve one private staging publication (expected 15 existing credits, freshly check before execution), temporary maximum-15-minute recovery settings, and one explicit application recovery of this existing PDF into the described new synthetic metadata series. No new PDF/upload, manual database insertion, credentials, grants, policy changes or production effects.

Then complete the previously bounded acceptance: one SKU and one catalog version referencing this PDF version; one estimate and one estimate version plus its document link; one budget series with two budget versions (estimate-based then facility-best-guess). Existing API transactions update only their respective head-version counters. Exact numeric inputs must be declared synthetic: USD two decimals, one each at 12000 minor units, 30 installation minutes per unit, hourly rate 8000 minor units yields 4000 labor and 16000 subtotal. Tax and fees remain unknown, so total remains unknown. An explicitly labeled facility-best-guess budget of 20000 minor units is not a quote. Preserve raw unknown replacement dates, source/as-of provenance and both budget versions. Do not fabricate a provider assignment: these tests use A's existing owner-authorized path.

Expected final logical counts: one document series/version, one SKU/catalog version, one estimate/version, one linked document, one budget series/two versions; still seven storage objects including the same PDF, six photos and two observations. No reviews, purchase orders, commitments, invoices, payments or messages. Inspect uncertain outcomes before retry; no new IDs to evade conflicts.

Rollback restores ce1bc72 and removes activation settings, preserving the created metadata/evidence and business versions. It does not delete data or undo history. Existing baseline reader can read the recovered document; existing estimating/budget interfaces remain compatible.

## Local validation

16 recovery/route/UI tests passed; 17 existing commercial/budget regression tests passed; API TypeScript and Facility Dashboard builds passed. Independent read-only review found no remaining actionable defect. Actual two-client localhost PostgreSQL probe verified the second transaction waits, replays the first result and leaves one version with zero storage writes. Fixture schema removed and local server stopped. No hosted write or permission probe was used.
