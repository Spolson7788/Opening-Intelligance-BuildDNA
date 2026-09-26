# OI Dashboard organization and demonstration checkpoint
Date: 2026-09-23
Verdict: HOLD for recording. Organization mapping and dataset are implemented; live-photo and connected-browser evidence remain pending.

## Environment and identity
Only isolated Supabase preview `lujfnhvkmllnpxkihhno` was changed.
Dataset: `STG-DASH-R1`.
A organization: `e4aba285-212c-4b39-afb8-3476b9db77bd`.
B organization: `60084863-50b5-4664-b7b8-4c3346c2e411`.
A facility: `d8466e9e-06a2-4d63-8981-43557758a421` — STG-DASH-R1 — Valley Medical demonstration.
B facility: `e27d1e74-53f4-43e6-a52f-5dce397ffa6e` — Organization B control.
Both preview accounts are normally provisioned and email-confirmed. No passwords, tokens or administrative keys were read, changed or included.

## Results
| Check | Result | Evidence scope |
|---|---|---|
| Organization membership plus facility permission required | PASS | SQL role tests on preview |
| Viewer organization role prevents writes even with facility admin role | PASS | SQL role test |
| Client self-enrollment and cross-organization membership links blocked | PASS | RLS and foreign-key assertions |
| Revoked organization membership removes former creator access | PASS | SQL role test |
| Paired opening, frame and active/inactive leaves | PASS | Persisted dataset query |
| Repeated CR441 closers retained as separate UUID records | PASS | Persisted dataset query |
| Completed pair: one eligible replacement, three excluded components | PASS | Purchasing RPC called under A role in SQL |
| Failed component with unresolved identity refused | PASS | Purchasing RPC under A role in SQL |
| Exact A opening and service records hidden from B; write denied | PASS | SQL role execution using preview account IDs |
| Local browser regression | PASS, 13 checks | Mocked server; not deployed-browser evidence |
| Browser upload, private retention, reload and authorized retrieval | NOT RUN | No deployed candidate/browser session |
| Connected identical photo replay returns already_applied | NOT RUN | No actual photo operation yet |
| B denial against A's actual private photograph | NOT RUN | No photograph exists |
| Connected Dashboard display and sign-in/recovery | NOT RUN | Separate protected frontend deployment needed |

Three SQL suites passed: organization access, service-role permissions, and component/completion/purchasing contract. Fixtures were rolled back. The persisted dataset was checked separately and remains saved.

Current security advisor: no database RLS findings; warning that leaked-password protection is disabled. See [Supabase password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). This warning is not resolved by the access-mapping work.

## Dataset and recommended recording path
All conditions, service entries and costs are synthetic demonstrations, not real inspection findings.
1. Dashboard: select STG-DASH-R1 — Valley Medical demonstration.
2. Show healthy, monitor, critical and unassessed states. The current condition mapping has no score in the Serious band; do not imply that every band is populated. The unassessed opening intentionally leaves the aggregate assessment incomplete.
3. Open `101-PAIR` (`91f2b6aa-6dcf-4e13-aaef-ce7f5155d730`): frame, active leaf, inactive leaf; two separate CR441 closers; hinge and exit device.
4. Show completed-opening purchasing: active closer eligible, inactive closer and hinge serviceable/excluded, exit device explicitly refused/excluded. Nothing sent.
5. Open `105-REFUSED` (`3619fe74-1f13-49ef-a7a4-ce186853eae0`): failed closer, unresolved identity; entire request refused.
6. Open `102-HEALTHY` for completed synthetic service history, then `103-MONITOR` and `104-UNASSESSED` to distinguish monitored and unknown condition.
7. Only after live-photo acceptance, show separately scoped photographs and retrieval.

A has five openings, eleven structure records, eight components, four saved completions, three service requests and one service event. B has one control opening. Photographs and storage objects: zero at verification.

## Live-photo test, next in sequence
Prerequisites: deploy this updated candidate to one protected nonproduction URL, pin its Git commit/hash, and authenticate A and B through normal sign-in. No production account reset or reassignment is needed.
1. Under A, choose 101-PAIR and upload a new browser photograph to the Opening target. Record operation UUID, photo UUID, storage path and source-byte SHA-256; do not record credentials or signed URLs in the public report.
2. Wait for synchronization; reload the same immutable URL. Retrieve via an authorized signed URL and compare downloaded-byte SHA-256 with the source.
3. Replay the original photo operation UUID and identical payload over the connected RPC. Require `already_applied` and unchanged metadata/object counts.
4. Under B, request exact A opening UUID and exact private storage path using B's own session. Require no record access and denial of download/signing. Do not reuse A's still-valid bearer signed URL as the denial test.
5. Add separate frame, active-leaf, inactive-leaf and component photographs, confirming each association after reload.
6. Retain sanitized network evidence and database counts. Only then mark connected photo/replay/isolation checks PASS.

## Limitations
The candidate frontend remains undeployed. Netlify CLI is unauthenticated; the installed deployment action cannot select this branch or upload the artifact. There is no authenticated browser capability available in this session.
The candidate editor is separate from the original recognition Field Identifier; that integration remains incomplete.
The catalog entry is demonstration-only, technician-selected, using an [archived manufacturer-authored CR441 catalog](https://mrlock.com/content/441.pdf) hosted by a distributor. It establishes no real installed product identity, compatibility or current specification.
Manufacturer sample sizes remain below the reporting threshold. No physical QR printing, recognition call, purchasing transmission or compliance certification is demonstrated.
Structure writes require connectivity; only component/photo writes are queued. Multi-organization users must specify an organization when creating facilities; the preview UI currently assumes one authorized admin organization.
Production, frozen PR2 deployment and R8 were not changed.

