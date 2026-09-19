# PR #2 Offline Sync Correction — Local Verification

Date: 2026-09-19  
Reviewed source head: `06cbde2667c68562af58b072e88c190909a3ecf1`  
Corrected commit: recorded in the delivery handoff after the manifest owner is completed  
Environment: isolated local PGlite/PostgreSQL-compatible test process; no connected staging or production resources

## Results

| Gate | Result |
|---|---|
| `git diff --check` | PASS |
| PostgreSQL-backed API suite | PASS — 36 files, 285 tests |
| Isolated offline suite | PASS — 4 files, 17 tests |
| Root TypeScript build | PASS |
| Field App production build | PASS |
| Dashboard production build | PASS |
| Root `npm audit --audit-level=low` | PASS — 0 vulnerabilities |
| Field App `npm audit --audit-level=low` | PASS — 0 vulnerabilities |
| Dashboard `npm audit --audit-level=low` | PASS — 0 vulnerabilities |

The API suite now exceeds the previously reported 277 tests because this
correction adds targeted coverage for permanent frame/leaf identity conflicts,
cross-organization service-event attribution, immutable photograph
geolocation, and automatic deletion-job recovery. The isolated suite adds
dependency graph and evolving-flush eligibility coverage.

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

## Isolation statement

No Supabase or Netlify project was provisioned or contacted. No production
credential, signed URL, private media object, or confidential test value is
included here. PR #2 remains open and unmerged, and connected staging remains
unauthorized.

## File-count reconciliation

For reviewed head `06cbde2`, the local merge base
`03cc8a83e238c191d8381e634c6c4951b12a072c` produces exactly 76 changed files,
matching GitHub's reviewed PR count. The corrected delivery adds new manifest,
worker, dependency-test, and evidence files and modifies the implementation and
tests described above. The final authoritative count must be captured from
GitHub after the corrected commit is pushed; any base movement must be reported
as a separate base/head comparison before staging authorization.
