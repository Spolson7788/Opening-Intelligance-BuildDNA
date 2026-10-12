# Offline synchronization and photograph retention — Phase 1 contract

## Scope and base

- Branch: `feat/offline-sync-photo-retention`
- Exact base: `1025653da46c9387d6afed7cf8cee142e2f71c14`
- Required ancestor: `e4441dde2e2e261d10e9e8b4b4d10d7f8e872e20`
- Phase 1 is a local persistence and protocol foundation. It does not replace the current connected API, run a database migration, or perform a storage upload.
- The frozen R8 demonstration build and assets are out of scope.

## Architecture decision

The Field App remains a PWA and IndexedDB remains its durable local store. The former version-2 cache and specialized queues remain available for compatibility. Version 3 adds normalized stores for the complete hierarchy and a durable operation model:

| Store | Key | Purpose |
|---|---|---|
| `entities` | `<entity-type>:<uuid>` | Local opening, frame, leaf, component, event, completion, and purchasing records |
| `operations` | operation UUID | Immutable, dependency-aware synchronization work |
| `media` | photograph UUID | Original blob, checksum, target, provenance, and upload state |
| `syncReceipts` | operation UUID | Proof of server identity, revision, acceptance, and verification |
| `conflicts` | conflict UUID | Preserved base, local, and connected values |
| `openingSnapshots` | opening UUID | Last verified connected hierarchy used for offline retrieval and three-way comparison |
| `settings` | stable string | Schema, device, retention, and migration settings |

The existing `openings`, `outbox`, `photoOutbox`, and `auth` stores are not removed or rewritten in Phase 1.

## Atomic local save

A meaningful technician action is considered **Saved locally** only after the entity and its corresponding operation have committed in one IndexedDB transaction. Identity and tenant mismatches are rejected before a transaction begins.

Media uses the same rule: the original blob and upload operation must commit together. A preview that exists only in memory must never be presented as safely saved.

## Permanent identity

Every new offline entity and operation uses a client-generated UUID. Human-facing codes, names, component classes, labels, and filenames are never permanent identity. The envelope binds each record to its organization, opening, user, device installation, schema version, and application version.

An operation ID is also its idempotency key. Once an operation has been attempted, its identity, tenant binding, entity target, and semantic payload are immutable. A later edit creates a later operation.

## States

Internal states map to the required technician-facing language:

| Internal state | Technician status |
|---|---|
| `local_committed` | Saved locally |
| `queued`, `retry_wait`, `blocked_dependency` | Waiting to sync |
| `in_flight`, `verifying` | Syncing |
| `verified` | Synced |
| `permanent_failure`, `auth_required`, `storage_pressure`, `schema_blocked` | Needs attention |
| `conflict` | Conflict requires review |

Precedence is conservative: conflict outranks attention, attention outranks active transfer, and active transfer outranks waiting. A record is not **Synced** merely because the queue is empty.

## Dependency and retry rules

- Opening creation precedes frame/leaf creation.
- The exact frame or leaf precedes a component mounted to it.
- A component/event precedes a photograph targeting it.
- All required hierarchy operations precede connected completion.
- Only operations whose dependencies have verified receipts are eligible to run.
- Retry uses bounded exponential backoff with jitter.
- A manual retry reuses the existing operation ID.
- Independent openings may later run with bounded concurrency; dependent operations within an opening remain ordered.

## Required connected acknowledgement

Phase 2 server work must return the operation ID, permanent entity ID, organization/opening relationship, resulting server revision, server acceptance time, and normalized record hash. The client stores a receipt only after those values match the intended operation.

For media, **Synced** additionally requires proof that the private storage object exists, matches the declared size/checksum, remains associated with the correct record, and can be retrieved by an authorized request.

## Conflict model

Conflict classification uses the last verified base, local proposed values, and current server values:

- Local-only: apply when the server revision still matches the base.
- Server-only: refresh fields not changed locally.
- Compatible: merge explicitly independent fields and audit the merge.
- Competing: preserve both versions and require review.
- Missing/inaccessible parent: block descendants; never reassign them.
- Authorization changed: deny synchronization and require attention.
- Photo ID/checksum mismatch: preserve the local original and raise a conflict.

No automatic conflict rule may move a frame, leaf, component, or photograph to another opening.

## Photograph contract

The `OfflineMediaRecord` contract retains the original blob plus permanent photograph/opening/target IDs; organization, user, and device; capture time; original and generated names; content type and byte size; SHA-256 checksum; optional dimensions; upload state; private storage-object identity; provenance; review state; and source-photo ID for derivatives.

The original is retained after successful synchronization until a user explicitly removes a verified local copy. Pending, failed, or conflicting originals are ineligible for routine cleanup.

The current API's client-supplied storage URL and absence of a server object check are not approved for the completed feature. The later connected protocol must reserve a private object, upload it, verify it server-side, confirm the database association, and verify authorized retrieval.

## Security constraints

- Current authorization must be checked before each queued write; old offline authorization is not sufficient.
- Organization and facility/opening isolation apply to records and storage objects.
- No service-role credential, unrestricted database credential, password, access token, permanent signed URL, photograph, or confidential source material may appear in logs.
- Supabase tables in exposed schemas require RLS and policies containing actual tenant predicates; `TO authenticated` alone is insufficient.
- Storage remains private. Upload, read, update, and deletion permissions are separately scoped.
- A web PWA cannot guarantee remote erasure of an offline device. Server revocation prevents later sync/retrieval; device lock, OS encryption, and local session expiry remain required controls.

## Phase 1 verification

The isolated test configuration deliberately has no database global setup. It verifies pure protocol behavior and IndexedDB transaction behavior using an in-memory standards-compatible IndexedDB implementation.

Run:

```bash
npm run test:offline-sync
cd field-app && npm run build
```

The full API suite remains the regression gate and requires the repository's local test database.

## Deferred to later authorized phases

- Connected API endpoints and Postgres migration
- RLS and Storage policies against an identified nonproduction Supabase target
- Migration of legacy queue contents into the new operation format
- Page-level adoption of the atomic local-save service
- Private photograph reservation/upload/verification/retrieval
- Conflict-resolution UI and support diagnostics
- Physical iOS and Android testing
- Dashboard restoration from a connected nonproduction hierarchy

No deferred item may be represented as available merely because the Phase 1 types and stores exist.
