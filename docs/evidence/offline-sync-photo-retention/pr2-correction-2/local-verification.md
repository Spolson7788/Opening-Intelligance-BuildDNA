# PR #2 Offline Sync Correction — Local Verification

Date: 2026-09-20

OS-reviewed remote source head: `9f853c259836c9c75a3aad5e255d20768862bd71`

Local equivalent source commit: `d2ec1e38f1380e541469808eb3940f06eadc037d`

Corrected implementation commit: `35879bf7479c62e0d20ad4623d90af100ca21f2b`

Tested implementation tree: `43117b479ca03eb373b5ff361810906693422b45`
Environment: isolated local PGlite/PostgreSQL-compatible test process; no connected staging or production resources

## Results

| Gate | Result |
|---|---|
| `git diff --check` | PASS |
| PostgreSQL-backed API suite | PASS — 39 files, 294 tests |
| Isolated offline suite | PASS — 6 files, 25 tests |
| Root TypeScript build | PASS |
| Field App production build | PASS |
| Dashboard production build | PASS |
| Root `npm audit --audit-level=high` | PASS — 0 vulnerabilities |
| Field App `npm audit --audit-level=high` | PASS — 0 vulnerabilities |
| Dashboard `npm audit --audit-level=high` | PASS — 0 vulnerabilities |

The API suite exceeds the previously reported 277 tests because the two local
correction passes add targeted coverage for permanent identity, service-event
attribution, photograph geolocation, deletion recovery, and immutable verified
media. The isolated suite adds dependency ordering, evolving-flush eligibility,
principal isolation, abandoned-lease recovery, issue visibility, and executable
hosting-package coverage.

## Targeted correction evidence

- Permanent identity: conflicting client IDs for an existing frame or leaf
  return `permanent_entity_identity_conflict` with the permanent server ID.
- Dependency ordering: components and photographs depend on outstanding parent
  operations; completion depends on outstanding frame, leaf, and component
  operations; receipts make dependent work eligible during the same flush.
- Deletion recovery: due jobs are claimed with `SKIP LOCKED`, limited to 25 per
  invocation and eight attempts per job, and finalized with a tenant-scoped
  metadata deletion and audit record. `npm run photos:process-deletions` is the
  scheduler-ready entry point.
- Service attribution: a client cannot attribute an event to another
  organization; the stored organization is derived from current server auth.
- Geolocation: latitude and longitude are retained in the offline media record,
  immutable reservation, canonical confirmation payload, and verified photo.
- Restart/account safety: dispatch claims are transactional and principal
  scoped. A live lease prevents another tab from sending the operation; an
  expired lease is recoverable; authorization-blocked work remains retained;
  and a different signed-in principal cannot claim or retry the prior user's
  work.
- Verified media immutability: upload authority targets an operation-scoped
  temporary key. Confirmation verifies and conditionally promotes the exact
  ETag to the canonical key. Once verified, reservation replay returns no
  upload URL, confirmation revalidates the canonical object, and altered bytes
  at the temporary key cannot replace the accepted object.
- Hosting: the Netlify Request/Response adapter executes `/health` locally and
  the bounded deletion processor has an explicit once-per-minute scheduled
  function. No site or schedule was created or enabled.

## Isolation statement

No Supabase or Netlify project was provisioned or contacted. No production
credential, signed URL, private media object, or confidential test value is
included here. PR #2 remains open and unmerged, and connected staging remains
unauthorized.

## File-count reconciliation

GitHub's OS-reviewed comparison reported 81 changed files for remote head
`9f853c259836c9c75a3aad5e255d20768862bd71`. Its locally reconstructed,
content-equivalent source commit `d2ec1e38f1380e541469808eb3940f06eadc037d`
also has exactly 81 paths against merge base
`03cc8a83e238c191d8381e634c6c4951b12a072c`. This correction changes or adds
paths already in that comparison plus nine new paths, producing 90 paths
against the same base. GitHub's authoritative post-delivery count must be
checked against base/head after an authorized push; any base movement must be
reported separately before staging authorization.

## Free recovery correction follow-up — 2026-09-20

Source commit: `d3616208b82aa5c1d8f91268ebebdfa18610dd57`

| Gate | Result |
|---|---|
| `git diff --check` | PASS |
| PostgreSQL-backed complete suite | PASS — 40 files, 300 tests |
| Isolated offline/recovery suite | PASS — 7 files, 31 tests |
| Root TypeScript build | PASS |
| Field App production build | PASS |
| Dashboard production build | PASS |
| Root, Field App and Dashboard high-severity dependency audits | PASS — 0 vulnerabilities |

Targeted executable evidence:

- `offlineSyncModel.test.ts` proves a pre-lease `in_flight` or `verifying`
  record with no lease metadata becomes recoverable after the same bounded
  two-minute grace period, while a recent request is not duplicated.
- `offlineDb.test.ts` proves the owning principal can restore an expired or
  legacy interrupted operation to `queued`, and proves an orphaned photograph
  reconstructs its operation without replacing or deleting the retained blob.
- `syncIssuesModel.test.ts` proves the review page surfaces both recoverable
  pre-lease interruptions and orphaned media with explicit recovery actions.
- `offlineFlushRecovery.test.ts` simulates server acceptance followed by a lost
  response. The retry reuses the same operation ID, obtains the idempotent
  receipt, and creates no second accepted identity.
- The same flush test switches from technician A to technician B immediately
  after A's first accepted request. A's accepted operation is receipted, the
  next A-owned operation remains queued, and no request is sent using B's
  session.

All recovery paths retain queued work. Orphan recovery persists the original
operation ID with the media record for new captures, uses a deterministic
legacy fallback, and leaves the original photograph blob in `retained` state.
No Supabase or Netlify resource was contacted or provisioned, no deployment was
performed, and PR #2 remains open and unmerged.

This follow-up adds one new test path and otherwise modifies existing PR paths,
so the local comparison is now 91 changed files against the same recorded merge
base. GitHub remains authoritative only after an authorized push and base/head
reconciliation.
