# Offline synchronization acceptance matrix

No row may be marked passed without environment, app/schema version, setup, actions, expected/actual results, and redacted evidence. Connected rows require an explicitly identified nonproduction database and private object store.

| ID | Scenario | Required proof | Phase 1 status |
|---|---|---|---|
| OS-01 | Single opening completed offline | Complete hierarchy persists; local completion remains distinct | Prepared |
| OS-02 | Paired opening completed offline | Frame plus active/inactive leaves and associations persist | Prepared |
| OS-03 | Multiple same-class components | Separate UUIDs; no overwrite | API and contract tested |
| OS-04 | Photos on opening/frame/leaves/components | Exact target UUID retained through sync | Prepared |
| OS-05 | Close and reopen application | Records, operations, blobs, states survive | Store prepared |
| OS-06 | Restart device/simulation | Queue and session policy survive | Prepared |
| OS-07 | Restore connectivity | Hierarchy syncs in dependency order | Ordering tested; connected test pending |
| OS-08 | Interrupt photograph upload | Same IDs resume without duplicate | Prepared |
| OS-09 | Replay component operation | One component and same receipt | API tested |
| OS-10 | Replay photograph operation | One row and one canonical object | Prepared |
| OS-11 | Checksum and authorized retrieval | Retrieved private object matches original SHA-256 | Prepared |
| OS-12 | Restore in Field App | Connected hierarchy and associations match | Prepared |
| OS-13 | Display in Dashboard | Connected hierarchy and media scope match | Prepared |
| OS-14 | Local vs connected completion | States never conflated | Contract defined |
| OS-15 | Update synchronized opening | New revision and immutable audit event | Prepared |
| OS-16 | Expire auth with pending work | Data retained; sync paused; reauth recovers | Prepared |
| OS-17 | Revoke access before sync | Write denied; Needs attention | Prepared |
| OS-18 | Cross-organization access | API and private object denied | Component/reservation API tested; storage pending |
| OS-19 | Competing edit | Both versions preserved and resolution audited | Conflict store prepared |
| OS-20 | Purchasing through retry | Eligibility/refusal unchanged | Prepared |
| OS-21 | Provider mapping isolation | No cross-provider lookup/use | Prepared |
| OS-22 | Diagnostic inspection | No credentials, signed URLs, sensitive data, or bytes | Contract prepared; connected inspection pending |
| OS-23 | Successful sync retention | Original remains until explicit verified cleanup | Contract defined |
| OS-24 | Device capability fallback | Manual/camera flow works without depth APIs | Prepared |

## Phase 1 automated checks

- Six user-facing states use conservative precedence.
- Dependency-blocked work is not selected.
- Retry time is enforced and ready operations retain creation order.
- Exponential retry delay is capped and jitter is bounded.
- Invalid operation/entity identities and dependency envelopes are rejected.
- Version-3 IndexedDB creates new stores while retaining legacy stores.
- Entity and operation commit atomically.
- Mismatched identity is rejected before either record is written.
- A receipt changes an operation to `verified` only after identity validation.

## Additional required failure tests

- Browser quota exhaustion before and during capture
- Duplicate tabs and simultaneous triggers
- Timeout after successful server commit but before client response
- Object upload succeeds but confirm fails
- Confirm succeeds but local receipt write is interrupted
- Parent rejected while descendants remain queued
- Facility authorization changes while offline
- Application update with prior-schema pending operations
- Device/server clock skew
- Corrupted local blob or checksum mismatch
- Unsupported and oversized media
- Cleanup refuses pending, failed, or conflicting originals
- Legacy opening cannot bypass paired-opening completion review

## Device/browser matrix

- Current and previous major iOS Safari/PWA on a supported iPhone
- Current and previous major Android Chrome/PWA on a representative Android device
- Current desktop Chrome and Edge for diagnostic parity
- Low-storage behavior and eviction response
- Private/incognito behavior documented as unsupported or explicitly tested

Camera capture, suspension/termination, storage persistence, reauthentication, and network transition require physical-device evidence. Desktop emulation is insufficient.
