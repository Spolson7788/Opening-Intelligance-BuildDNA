# Offline synchronization and photo retention — Phase 1

Authoritative base: `feat/paired-opening-data-model` at
`1025653da46c9387d6afed7cf8cee142e2f71c14`.

## Delivered contract

- Frames, door leaves, installed components, opening completion, service events,
  inspection events, and photographs are written to IndexedDB before network work.
- Mutations carry stable client operation IDs and flush in capture order.
- New frames and leaves retain immutable client-generated IDs, so components
  captured offline can reference their parents before either reaches the server.
- Hardware and photograph confirmation are idempotent at the API/database boundary.
- Photo object keys reuse the client operation ID, preventing duplicate stored
  objects when presign, upload, or confirmation is retried.
- Photos retain their opening, frame, leaf, or installed-component scope.
- Pending, syncing, retrying, and conflict states are visible in the Field App.
- HTTP 409 responses remain locally preserved as conflicts instead of being
  discarded or repeatedly submitted.
- Cached opening structure is updated immediately for offline frame and leaf work.
- Pending opening completion is persisted in the local opening cache across restart.
- Server-side storage-key validation prevents cross-tenant/cross-opening binding.

## Migration and rollback

- Migration: `migrations/014_offline_sync_photo_retention.sql`
- Rollback: `docs/rollback/014_offline_sync_photo_retention_rollback.sql`

The migration stores the provider-independent storage object key alongside the
delivery URL. Existing rows are backfilled from their current URL when possible.

## Deferred beyond Phase 1

- Interactive conflict-resolution editing (Phase 1 preserves and flags conflicts).
- Background Sync API integration when the browser is fully closed.
- Remote wipe and fleet/device administration.
- Resumable multipart/TUS uploads for very large media.
- Server-side HEAD verification and enforced byte-size limits after upload.
- Broad physical-device certification across iOS and Android versions.

No production Supabase, Netlify, storage bucket, or demonstration build is changed
by this branch.
