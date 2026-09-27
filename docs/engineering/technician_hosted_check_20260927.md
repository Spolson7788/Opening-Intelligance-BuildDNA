# Technician hosted verification — 2026-09-27

Preview commit bbb262e37a6ac9bf23dd48891319f006e3dae53d, deploy 6ab914553466ee00086b2d3c.
User stg-tech-a@oi-nonprod.invalid, existing technician authority retained.

Observed through authenticated hosted UI after user-completed password recovery and login:
- Facility inventory: STG-DASH-R1, STG-FAC-A1, SYNTHETIC ACCEPTANCE 20260926 — disposable provider tests (three).
- State CA reduces inventory to one synthetic acceptance facility.
- Assigned opening SYNTHETIC-ACCEPTANCE-20260926-ELIGIBLE resolves successfully.
- Associated closer photograph rendered: complete=true, natural dimensions 503x423. No signed URL collected.
- Dashboard reuses same-origin Field App session, loads same three facilities without another sign-in.
- Synthetic facility displays four openings, twelve parts.
- Purchasing review refuses incomplete opening, unresolved replacement identity and missing supporting approval; serviceable closer excluded. No order or message sent.

NOT full acceptance: second-company isolation, revocation/queued writes, interrupted uploads and recovery remain unverified in this session. Positive eligible purchasing case not demonstrated (fixture deliberately has no supporting approval). Technician A has no branch assignment; California filtering works but California default for this account remains outstanding. No production readiness verdict.

Evidence screenshot: /workspace/scratch/oi-technician-purchasing-verified.jpg.

## Continuation — California defaults, isolation and synchronization

- Operator applied the approved synthetic California branch assignment for Technician A: branch 8ea8cf38-4a78-4fb8-b96f-bbfdb10540a1, company d74b3113-5c0f-4cb8-b5fc-bb7ae0687020. Defaults CA / QA Acceptance. Assignment attributed to authorized owner/operator cee64c92-2c5e-4470-87dd-c96b43aa22b6; applied through database administration, not tested through company-admin UI.
- Both hosted applications automatically selected CA and QA Acceptance after reload/navigation; one authorized facility remained. No facility grant was added by the branch assignment.
- Technician A lookup of the existing company-B opening STG-20260920-01-A-001 returned Opening unavailable. This proves A-to-B opening denial, not bidirectional isolation or direct private-photo denial.
- Temporarily revoked the existing provider grant for disposable facility 1df79d1f-d01d-441a-835c-86680f8e9da7. Previously accessible opening bc705886-82df-44f8-b493-7e3ca46f229b then returned Opening unavailable using the existing session. Restored the original grant and confirmed opening and photo returned. Queued-write revocation not exercised.
- Changed synthetic component model via Field App from QA-ELIGIBLE to QA-ELIGIBLE-SYNC-CHECK; observed changed model in the connected Dashboard. Restored QA-ELIGIBLE through the Field App; clicked Refresh saved records on the already-open Dashboard and confirmed original model present, temporary model absent. This demonstrates saved-change visibility on refresh. Exact latency was not measured; no realtime claim.
- Local offline/recovery suite: 16 files, 72 tests passed. These do not replace hosted fault injection.

Evidence: /workspace/scratch/oi-ca-branch-default-verified.jpg and /workspace/scratch/oi-provider-dashboard-current.jpg.

Remaining acceptance blockers: no signed-in company-B or company-admin session; this cloud browser exposes no supported network-offline/response-loss control, and its session may not be extracted for an external runner. Therefore interrupted uploads, queued-write revocation, account switching, and bidirectional/private-photo isolation are not fully accepted. Positive purchasing eligibility still requires legitimate synthetic supporting-document approval; no approval was fabricated. Production release and recording handoff remain held.

Rollback of synthetic branch assignment only (if requested): remove user_branch_assignments row for Technician A bound to branch 8ea8cf38-4a78-4fb8-b96f-bbfdb10540a1, then delete that branch if unreferenced. Existing facility grants and account role remain unchanged.
