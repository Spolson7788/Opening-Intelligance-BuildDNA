# Offline synchronization and photo retention — Phase 2 checkpoint

Branch: `feat/offline-sync-photo-retention`

## Development changes

- Client-generated component IDs now remain permanent at the API boundary.
- Frames, door leaves, and newly captured components can receive scoped photos
  before any parent record has synchronized.
- Newly queued components appear in the cached opening immediately.
- Failed and conflicting mutations remain on-device and have a dedicated review
  screen with an explicit retry-after-review action.
- The server continues to validate that every frame, leaf, component, photo,
  and storage key belongs to the authenticated opening and organization.
- Supabase Data API access is denied by enabling RLS on all 17 application
  tables without granting direct browser policies; OI continues to enforce
  tenant scope through its authenticated server API.

## Automated verification

- Focused paired-opening/offline suite: 18 tests.
- Full API suite: 241 tests.
- API TypeScript build, Field App production build/lint, and Facility Dashboard
  production build are required before publication.

## Connected validation still required

No nonproduction Supabase project, S3-compatible test bucket, test API deployment,
or device credentials are configured in this worktree. Before merge or deployment,
run the connected test matrix against an explicitly identified nonproduction
environment:

1. Capture a paired opening, frame, both leaves, repeated component classes, and
   scoped photos while offline on iOS and Android.
2. Terminate and reopen the app; verify hierarchy, blobs, completion state, and
   queued status remain intact.
3. Reconnect; verify ordered sync, idempotent retries, stored objects, database
   associations, and Dashboard retrieval.
4. Force a 409 conflict; verify the record remains visible and can be reviewed
   and retried without data loss.
5. Verify cross-organization denial for frames, leaves, components, presign,
   confirmation, retrieval, and photographs.

Do not point destructive test commands at production. No production Supabase,
Netlify, storage bucket, data, or frozen demonstration asset is changed here.
