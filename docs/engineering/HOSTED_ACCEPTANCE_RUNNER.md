# Hosted acceptance runner — bounded execution, not a release certificate

OS3 owns preparation, corrections and final adjudication. This runner is for a separately authorized operator environment with Playwright network controls. It was syntax-checked and its configuration guards tested; it has NOT been executed against hosted services. It is not a workaround for the browser-policy denial on deployment-manifest retrieval, which remains a separate unresolved gate.

## Required before execution

- Immutable protected nonproduction deployment matching the intended candidate. Keep Netlify access protection enabled. The configured commit is an expectation, not a verified fact.
- Two active synthetic technician accounts in DIFFERENT companies, with their exact permitted facility inventories established independently. The runner verifies current technician roles through the hosted API and rejects identical organization membership. The existing recording account is admin and will correctly be rejected here.
- Technician A must access a disposable SYNTHETIC-labelled opening through an existing provider assignment (A must not own it). Technician B must be denied that opening and an existing private photo. A third secure sign-in is required for the synthetic facility owner administrator, in a different company from A. The runner temporarily revokes this existing assignment, checks denial and retained queued media, and restores it before recovery. It attempts restoration in a finally block if the test fails.
- Four configured purchasing datasets: eligible with expected nonzero item count; unresolved-document blocked with zero items; mixed eligible plus incomplete blocked with zero items; all-serviceable with zero items and blocked=false. Resolve every identifier against actual synthetic records before running.
- Approved JPEG path and its full SHA-256. Use a disposable synthetic opening: three new photo attachments are intentionally retained as evidence, not deleted automatically.
- Playwright and its Chromium installation in the operator environment. Follow that environment's existing package/installation policy. No key, password, token or browser profile should be sent back to OS3.

## Run

From repository root, create an untracked local configuration from the example, replacing every placeholder. Then:

```
node scripts/hosted-acceptance.cjs acceptance.local.json hosted-acceptance-results.json
```

Complete sign-in manually in each separate browser context. Open Facilities and openings before pressing Enter in the terminal. Never type credentials into the terminal. The runner captures application authorization only in process memory and never exports it. Contexts are ephemeral and not saved.

## What it actually checks

- Exact authorized facility inventory in each company.
- Company B receives 404 for A's opening and private-photo access endpoint.
- Owner-admin revocation removes search/opening/private-photo access; a queued photo is held as auth_required and retained locally, then sent only after assignment restoration and explicit retry.
- Purchasing blocked flag and item count for each supplied review-only case; no purchasing send/order endpoint is invoked.
- Actual UI photo selection while offline; retained local blob; reconnection; server photo association and exactly one new record; local verified state after reload.
- A successful server confirmation whose response is deliberately dropped; actual UI retry/reload; verified local state and exactly one server photo.

The runner blocks service workers to ensure request interception sees confirmation traffic. Its result therefore does NOT establish service-worker restart or offline navigation acceptance. It does not simulate partial object-upload interruption; it tests offline capture and lost confirmation response. It does not verify every purchasing exclusion reason or exact item identity, only configured blocked/item-count outcomes.

## Remaining acceptance, even if this runner passes

- Account switch during queued upload and in-flight response.
- Interrupted object upload; service-worker/browser restart; legacy orphan and expired lease recovery in the hosted app.
- Exact purchasing item identities, exclusion reasons and document bindings.
- Deployed artifact hashes, commit correspondence and complete post-deploy smoke test.

Report verdict deliberately remains BOUNDED_CHECKS_PASS_FULL_ACCEPTANCE_INCOMPLETE. A failing check stops execution; do not convert a failure or timeout into a pass. Return only the generated report and deliberately selected, redacted screenshots. Do not return profiles, traces, HAR files or signed URLs.

## Access request, consolidated

Supply authorized execution access to a machine/runner with network controls and secure interactive sign-in for two synthetic technician accounts and the synthetic facility owner administrator. OS3 must prepare and pin their facility/purchasing fixtures first. This is an execution-access dependency, not a request to approve production deployment. Manifest verification requires a permitted evidence route separately; do not bypass browser security policy.
