# Chat handoff — Thrive staging patch v3 (NOT deployed)

**For:** Chat (OI implementer)  
**From:** Grok Bot / Stephan  
**Date:** 2026-10-23 (America/Chicago)  
**Action:** Review only until Stephan authorizes Netlify Drop redeploy. Do **not** enable importer, make bucket public, change credentials/permissions/policies, or touch production.

## North star
OI correctly identifies brand+series+model of installed door hardware from field photos, and gets better from technician-confirmed field use. This patch is a **staging UI safety** gate on Thrive schedule inspect/portal so field writes cannot run without a successfully initialized staging guard — it does not itself advance recognition accuracy, but protects staging before write-enable work.

## Build identity
- Netlify Drop site: `oi-thrive-schedule-staging`
- Deploy ID: `6ad40355d11faef8a0292823`
- Baseline zip SHA-256: `5bd7161bb78df9e0b421f9bc0d794d0116b62186ba679a7a3adfa75499afcb64`
- These HTML pages are **Drop-only** (not previously in this GitHub repo). Patch against the baseline zip / Drop tree, not an assumed git SHA.

## Package contents (this folder)
| File | Purpose |
|---|---|
| `staging-guard-ready-signal-and-write-recheck-v3.patch` | Unified diff vs original Drop (`inspect.html`, `portal.html`, `staging/guard.js`) |
| `EVIDENCE.md` | Full evidence, checksums, test matrix |
| `run-tests.mjs` + `package.json` + `test-source-v3.tgz` | **Runnable** mocked/jsdom tests (not results alone) |
| `results.json` | Last run: 25/25 PASS |
| `deploy-6ad40355d11faef8a0292823.zip` | Exact baseline Drop |
| `RPC_AUTH_READONLY.md` | Prior read-only RPC/Auth notes (not re-verified in v3) |

## Behavior summary
1. **guard.js** signals readiness (`__OI_STAGING_GUARD__` → `ok` + `oi-staging-guard-ready`) **only after successful `start()`** (existing restrictions preserved). Throw → `fail`. Script **onload is not success**.
2. **inspect.html:** `#save`/`#photos` start disabled; recheck gate before inspection insert, each photo upload, and each photo-record insert after upload. Mid-stop → partial-failure message (not success); **no** auto-delete.
3. **portal.html:** signed URLs only; visible photo-load errors (kept from v2).

## Honest test scope
Mocked/jsdom only. **No live writes and no database-permission bypass were tested.**

## Ask of Chat
1. Review patch + EVIDENCE + run `run-tests.mjs` (after `npm i` in the test package).
2. Do **not** deploy until Stephan says so.
3. If implementing further, keep staging-only; preserve importer disabled and private `opening-photos`.
