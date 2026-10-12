# Offline synchronization and photograph retention — Phase 2 assessment

## Status

Phase 2 local development establishes the first connected protocol slice. It has not been pushed, merged, deployed, or applied to Supabase, Netlify, production, or any connected environment.

## Database contract

Migration `014_offline_sync_foundation.sql` is additive. It adds:

- revision and client-operation fields to synchronizable hierarchy/event records;
- private-media identity, checksum, size, verification, and retention metadata;
- durable synchronization receipts;
- domain synchronization audit events; and
- private photograph upload reservations.

The new internal protocol tables have RLS enabled and all `PUBLIC` privileges revoked. No browser policy is created. This is deliberate: the current application uses its authenticated API server, and the mapping between the application's `users.id` and a future Supabase `auth.uid()` has not been established. Adding a guessed policy would create an authorization defect.

Supabase's 2026 Data API default change also means any future direct Data API use must explicitly grant the minimum required table privileges in addition to enabling RLS and defining tenant predicates. This migration does not expose the protocol tables.

## Idempotent component creation

`POST /api/sync/components` accepts a permanent client entity ID and immutable operation ID. It:

1. verifies current authentication and role permission;
2. locks and verifies the opening through the caller's organization;
3. returns the existing receipt for an exact replay;
4. rejects reuse of an operation ID with a different entity or payload hash;
5. verifies the component's frame/leaf target belongs to the opening;
6. creates the component with revision 1;
7. records the normalized response receipt; and
8. records a domain audit event in the same transaction.

Multiple same-class components remain independent because each uses a permanent component UUID. A provider SKU is not accepted by this endpoint and therefore cannot establish product identity.

## Private photograph protocol

### Reserve

`POST /api/photos/offline/reserve` validates tenant, opening, exact hierarchy target, content type, size, SHA-256, device, photo ID, and operation ID. It derives a private object key from trusted organization/opening/photo identity. An exact retry returns the same reservation with a fresh short-lived upload authorization. A changed retry is rejected.

No reservation is stored if private storage is not configured.

### Confirm and verify

`POST /api/photos/offline/confirm`:

1. returns a prior verified receipt for an exact replay;
2. requires an owned reservation;
3. performs a storage `HEAD` check;
4. verifies size, content type, SHA-256 metadata, and photo identity;
5. retrieves the private object through the authorized server path and recomputes SHA-256;
6. creates the photograph record and exact hierarchy association;
7. records storage and authorized-retrieval verification times;
8. writes receipt and audit evidence transactionally; and
9. marks the reservation verified.

The protocol never accepts a client-supplied public storage URL. Existing legacy endpoints remain unchanged for compatibility and are not upgraded by implication.

### Access

`GET /api/photos/:id/access` verifies the photograph through the caller's organization and returns a short-lived private read authorization. It refuses legacy media that has no private object identity.

## Verification

- Phase 1 isolated protocol/IndexedDB tests: 10 passing.
- Phase 2 migration/API tests: 13 passing.
- API TypeScript build: passing.
- Full regression suite and all frontend builds remain required after the final Phase 2 diff is stable.

## Security position

- No service credentials are sent to the Field App.
- Short-lived storage authorizations are created only after API tenant checks.
- Storage keys do not contain original filenames.
- Operation replay is scoped by organization and immutable identity/hash.
- Direct browser access to the new protocol tables is denied.
- Logs must continue to redact signed URLs, tokens, bytes, checksums when customer policy treats them as sensitive, and request payloads containing facility data.

## Known limitations and next engineering slice

- Opening, frame, leaf, event, completion, and purchasing mutations still need the same receipt/revision protocol.
- Update operations require base-revision conflict detection and field-level three-way comparison.
- Existing Field App pages do not yet use the new endpoints or version-3 stores.
- Existing queued events/media have not been converted to the new operation format.
- The private storage round trip has only contract and refusal testing locally; a real object-store test requires an explicitly identified nonproduction target.
- Supabase RLS/Storage policies cannot be finalized until the application-user-to-Supabase-auth mapping and nonproduction project are identified.
- Physical iOS and Android persistence/interruption tests remain outstanding.

## Recommendation

Keep integration withheld. Complete the remaining domain endpoints and Field App adoption locally, then review the migration and rollback. Only after that review should a specifically named nonproduction database and private storage bucket be authorized for connected testing.
