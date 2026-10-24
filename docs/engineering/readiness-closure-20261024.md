# Local readiness closure, 2026-10-24

Four stale PATCH fixtures now supply Number(created.body.revision): three in tests/hardware.test.ts and the technician edit in tests/rolePermissions.test.ts. No assertions, application code, permissions or recovery fixtures changed. Existing revision tests still require missing/stale revisions to return 409. The affected suites passed all 36 checks on disposable localhost PostgreSQL 17.11 after applying all 28 migrations.

Initial local test attempt failed ECONNREFUSED because restarting the cluster without its launch arguments used localhost port 5432. The same temporary cluster was stopped and restarted explicitly with -h 127.0.0.1 -p 55479, then the test passed. No hosted database or machine security change was used.

## Reproducible runner split

Run from repository root with locked dependencies installed. Set TEST_DATABASE_URL explicitly to the approved disposable localhost database; globalSetup drops/recreates that named database. Never use a hosted/customer database. Run database suites sequentially, not alongside another database invocation.

Affected suites:

```powershell
node node_modules/vitest/vitest.mjs run tests/hardware.test.ts tests/rolePermissions.test.ts tests/videoWorkflowRevisions.test.ts
```

Completed dependency API regression (144 passed on 68c1bc7):

```powershell
node node_modules/vitest/vitest.mjs run tests/zodMigration.test.ts tests/auth.test.ts tests/authResponse.test.ts tests/videoWorkflowConcurrency.test.ts tests/videoWorkflowRevisions.test.ts tests/videoServiceRequests.test.ts tests/lifecycleOperations.test.ts tests/installationLifecycle.test.ts tests/commercialVersions.test.ts tests/planningSandbox.test.ts tests/sandboxFinance.test.ts tests/requestParserSecurity.test.ts tests/bulkImport.test.ts tests/bulkImportHardware.test.ts tests/events.test.ts tests/workOrders.test.ts tests/maintenanceSchedules.test.ts tests/tenantIsolation.test.ts tests/offlineSyncApi.test.ts tests/pairedOpenings.test.ts tests/videoLabels.test.ts
```

Completed UI regression (55 passed on 68c1bc7), each command independently:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.video-ui.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.wp3-ui.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.wp4-client.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.photo-diagnostic.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.capture-access.config.ts
```

The broad `vitest run tests` attempt was interrupted, not passed. Its log recorded four missing-revision failures and zero-test collection failures for photoDiagnostic.test.tsx and captureAccessUi.test.tsx. The general config uses Node, lacks the dedicated React aliases and photo-isolation compile definitions, and does not exclude those TSX suites. Their dedicated configs supply jsdom, aliases and definitions; both passed separately. The interrupted log does not establish the precise collection exception or the reason progress stopped. Do not describe that stall as a proven deadlock or claim every repository test has passed. This runner split reproduces the completed evidence, not exhaustive repository coverage. Windows symlink fixture remains unvalidated (EPERM); no OS changes or remote CI were attempted.

## Read-only staging protection finding

Exact site: 80fbbee8-b9d3-4b16-b93f-d2d8396591ec, oi-connected-release-candidate.netlify.app, owned by stephan-o's team. Current published deploy remains 6ada331f8b125c67182d7422. Connector legacy password/SSO booleans are false, but the authenticated current Netlify UI shows customized Private visibility, applying to Production and previews. The editor was inspected and cancelled without changes. Billing UI confirms credit-based Pro. This supersedes the earlier inference that the site was public; false legacy booleans alone do not establish current project visibility. No anonymous enforcement or historic deploy-URL test was performed this turn.

Recommendation: retain Private / Production and previews for this site only. This is Netlify login protection, separate from OI app authentication. Do not use previews-only because the candidate is served in Netlify's production context. No new protection charge or plan upgrade is needed to retain the existing setting. External testers need approved invitations (prefer project-scoped Reviewer where available), then Netlify login followed by OI login. Git Contributor alone does not grant protected-site access. No invitation was sent; current UI showed one team member. A shared-password alternative is available on Pro but gives anyone holding it perimeter access; it is unnecessary for the recommended private release. Do not enable corporate SAML or change team-wide defaults.

Sources: https://docs.netlify.com/manage/security/secure-access-to-sites/project-visibility/ and https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/. Current settings: https://app.netlify.com/projects/oi-connected-release-candidate/configuration/general/#project-visibility . Public Pro pricing is $20/month with unlimited members (https://www.netlify.com/pricing/); existing account charges were not changed.

## Specific questions for the operator/parent

1. Which tester email addresses, if any, should be granted project-scoped Reviewer access to this private site? Approve each recipient/scope before inviting. Keeping existing protection itself needs no mutation.
2. Confirm only the database project reference used by this site's production-context Functions: is it ioqfdcehnhnqpnqawwvo, and is it isolated staging? Do not send a connection string, password or environment dump. The denied environment listing was not retried or obtained indirectly.
3. After that mapping and a restorable backup are verified, approve the separately enumerated seven-migration delta, including its RLS/revocations/server-role grants, against that exact target. No blanket migration approval is requested here.
4. After schema acceptance and rollback verification, approve the exact release commit/site publication proposal. No publication approval is presumed from local readiness work.

Private storage adapter implementation and financial-policy gaps remain disabled. Physical QR and hosted auth/tenant/pooler checks remain outstanding. Recognition is held. No hosted mutation, deploy, push, external send or billing change occurred.
