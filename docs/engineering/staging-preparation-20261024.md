# Restricted staging preparation, 2026-10-24

Candidate 91c0548 is preserved. This follow-up adds a Windows-compatible npm CLI invocation to the existing isolated release builder and two real PostgreSQL concurrency tests. No feature, access, deployment guard or dependency lockfile change is included.

## Approved local setup and evidence

Root, Field and React Dashboard lockfile installs completed. Initial sandbox registry requests failed EACCES; approved escalated executions succeeded using the task-local npm cache. No global install occurred.

PostgreSQL official Windows download page linked to EDB's binary archive page, which linked PostgreSQL 17.11 Windows x86-64 to https://sbp.enterprisedb.com/getfile.jsp?fileid=1260616. Archive SHA-256: 80379B2C04D51C30225532E0AE04509899141E9957ED096FE749D7FD9DF8F82F. This is a locally measured identity, not a comparison against a separately published vendor checksum. postgres.exe reported 17.11; Authenticode status was NotSigned. No new runtime installation was needed. Binaries and disposable data are in the task's .local-postgres17 folder, outside the repository.

The cluster used SCRAM authentication and listened only on 127.0.0.1:55479, without a Windows service. Sandbox pg_ctl could not create its restricted Windows token; approved escalation started the same local instance without changing security settings. Only synthetic data and a synthetic API role were created. No hosted database was used for testing.

All 28 repository migrations applied to a fresh database. Eight test files passed, 39 tests total: videoWorkflowConcurrency, videoWorkflowRevisions, videoServiceRequests, lifecycleOperations, installationLifecycle, commercialVersions, planningSandbox and sandboxFinance. Concurrency tests use separate PostgreSQL backends, held target row locks and observed waiting sessions before release. They verify duplicate creates, competing component revisions, duplicate replacement receipts, simultaneous successor commands, single active instance, paired-leaf preservation and a single revision increment. Existing tests also cover API role access, tenant denial, revoked provider replay, private-photo attribution and disabled financial writes.

Full configured release build passed after correcting Windows execFileSync of npm.cmd to invoke the installed npm CLI through Node. Linux invocation and exact staging-context guard are unchanged. API, Field, React Dashboard and Facility Dashboard outputs were produced. Local reproduction uses the intended target context; it is not a hosted Netlify build, function bundle or deploy acceptance. Initial build manifest identified base 91c0548 plus the uncommitted Windows fix; a final committed-tree build is required for exact artifact attribution. TypeScript noEmit and whitespace checks passed. Release guard accepted the intended context and rejected five forbidden contexts.

Function-evidence tests: four passed; the symlink rejection test could not construct its fixture because Windows returned EPERM. No Developer Mode, privilege or machine security change was made. This remains an environment-limited test, not a passing result.

Independent read-only reviewer identified and prompted corrections to replacement replay status expectations and actual transaction overlap/race assertions. No application defect was demonstrated by the final 39-test run.

## Dependency findings remain unresolved

Locked install audits reported root 7 findings (1 critical, 4 high, 2 moderate), Field 5 (3 high, 1 moderate, 1 low), Dashboard 2 high. Counts overlap across projects. Root findings include proxy-addr IP spoofing, body-parser and zod resource-exhaustion advisories, plus build/test tooling. These are dependency scanner findings, not proof of exploitability in this app. No audit fix or lockfile upgrade was authorized or performed; zod's suggested fix is a major-version change. Triage/remediation or explicit bounded risk acceptance is needed before staging publication. Reports are under .local/*-audit-20261024.json.

## Hosted proposal remains gated

Verified Netlify site 80fbbee8-b9d3-4b16-b93f-d2d8396591ec / oi-connected-release-candidate.netlify.app currently publishes ce40fa8 at deploy 6ada331f8b125c67182d7422. Connector reports public with neither password nor team-login protection. Exact site-to-database mapping is still unconfirmed. Broad environment-variable retrieval was rejected by automatic review and was not retried or obtained indirectly.

Known Supabase staging project ioqfdcehnhnqpnqawwvo has the existing paired/offline/recovery/locking prerequisites, but no repository schema_migrations ledger. Supabase history has additional prior changes. Seven new candidate migrations introduce 24 tables, one view, two functions, three component columns and related constraints/indexes/triggers. Their new objects are absent. Do not blindly run the repository migration runner against this existing database.

Before any hosted action: obtain non-secret confirmation of the site's production-context Functions database project reference; choose and explicitly approve site perimeter protection; reconcile/approve the seven-migration delta including RLS, revocations and server-role grants; verify a restorable backup and paired app/data rollback; resolve dependency findings; then present the exact release-branch publication proposal. Commercial private storage integration remains absent and fails closed; sandbox financial writes remain disabled. No real sends/POs/payments or recognition work are included.

Local PostgreSQL concurrency evidence now exists, but does not prove hosted pooler behavior, hosted schema compatibility, provider integration, physical printing/scanning or production readiness.
