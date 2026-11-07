# Staging patch evidence — oi-thrive-schedule-staging (REVISED v3)

**NOT DEPLOYED — awaiting Stephan review/authorization**

## Build identity

| Field | Value |
|---|---|
| Netlify site | oi-thrive-schedule-staging (Netlify Drop / private) |
| Deploy ID | `6ad40355d11faef8a0292823` |
| Source of truth | Drop tree `/workspace/oi_staging/deploy_6ad40355/` (UNTOUCHED) |
| Baseline zip | `/home/box/Downloads/deploy-6ad40355d11faef8a0292823.zip` (copy also at `/workspace/oi_staging/patches/deploy-6ad40355d11faef8a0292823.zip`) |
| Zip SHA-256 | `5bd7161bb78df9e0b421f9bc0d794d0116b62186ba679a7a3adfa75499afcb64` (verified) |
| Patch working copy | `/workspace/oi_staging/patch_6ad40355_v3/` (fresh copy from original Drop) |
| Prior working copies | `patch_6ad40355/` (historical), `patch_6ad40355_v2/` (reference only; superseded — used script `onload` as ready) |
| Unified diff (v3) | `/workspace/oi_staging/patches/staging-guard-ready-signal-and-write-recheck-v3.patch` |
| Superseded patches | `staging-guard-inspect-and-signed-only-portal.patch`, `staging-guard-inspect-writes-and-portal-photo-errors.patch` |
| RPC note | `/workspace/oi_staging/patches/RPC_AUTH_READONLY.md` — **unchanged** (not re-verified this revision) |

## Why v3 (vs v2)

Stephan rejected treating the guard script tag **`onload` as proof of guard success**. Script load alone is insufficient. Readiness must come from an **explicit post-init signal from `guard.js`** after existing restrictions are applied successfully. v3 also rechecks readiness **immediately before every write**, including the photo-record insert after an awaited upload, and surfaces an accurate **partial-failure** message (no auto-delete of uploaded objects).

## What changed (patch copy only; vs original Drop)

`diff -rq` original vs `patch_6ad40355_v3`: **only** `inspect.html`, `portal.html`, and `staging/guard.js` differ.

### 1. staging/guard.js (NEW in v3 — minimal extension)

**Preserved:** QA notice (`#stagingNotice`), click-block + disable of facility/vision/purchasing controls, `MutationObserver` re-disable — all existing restrictions kept.

**Added:**
- `window.__OI_STAGING_GUARD__` API (`ready`, `status`, optional `error`), defaulting to `{ready:false,status:'pending'}` (reuses object if Inspect pre-seeded it).
- `start()` wrapped in **try/catch**.
- **`signalReady()`** only after notice + disable + observer applied successfully → `ready=true`, `status='ok'`, event `oi-staging-guard-ready`.
- **`signalFail(err)`** on throw → `ready=false`, `status='fail'`, event `oi-staging-guard-fail`.
- Script load alone never sets `ok`.

### 2. inspect.html

**Kept from prior:**
- Wrap with `<!DOCTYPE html><html>…</html>`, load `/staging/guard.js`, `data-schedule-staging="bound-review"`.
- `#save` / `#photos` start **`disabled`** (default-blocked).

**CRITICAL vs v2:**
- Pre-seed pending: `window.__OI_STAGING_GUARD__={ready:false,status:"pending"}` before the guard script.
- Guard `<script>` has **`onerror` → fail** only (script missing/network). **No `onload` success handler.**
- `stagingGuardAllowsWrites()` requires `ready===true && status==='ok'` from the guard API (post-init signal).
- Listen for `oi-staging-guard-ready` / `oi-staging-guard-fail` to enable/disable controls.
- **Recheck immediately before every write:**
  - before save / inspection insert
  - before each photo **upload**
  - before each **photo-record insert after an awaited upload**
- If stopped partway: show **`⚠ Partial failure:…`** (not success). **No automatic deletion** of already-uploaded objects.

### 3. portal.html (same as v2 — kept)

- Signed URLs only (no `getPublicUrl`).
- Visible `.photo-load-error` / `role="alert"` for missing signed URL, rejected `createSignedUrl`, `img.onerror`.
- Success path unchanged.

### Unchanged / non-actions

- Original Drop tree checksums intact.
- No credentials, permissions, RLS/policies, importer `enabled`, bucket public flag, or production changes.
- No Netlify deploy. No Supabase mutations from this work.
- `RPC_AUTH_READONLY.md` not re-run.

## Checksums

| File | SHA-256 |
|---|---|
| baseline zip | `5bd7161bb78df9e0b421f9bc0d794d0116b62186ba679a7a3adfa75499afcb64` |
| original inspect.html | `58449f29c02ca36a2aa218b6c739ab0046bbddd48ea5fb12508cfefc37d9bd94` |
| original portal.html | `342c6d2203f7468746cce3b6a0ea71aa17932c0be2e4ebc3f6eeed2616e6996a` |
| original staging/guard.js | `015550c798eaa8261525c6aaa734ddca697b4f769c975a6a0b969890a2e6cc27` |
| patched inspect.html (v3) | `5608debf1c7443cd4c030f7d64f4cf74cfe5a67947e37bb6dc6e4736708c0898` |
| patched portal.html (v3) | `2c396f10e4aca68d3f1e0c7a7191a35fc39176cccc2271b5954f17ef4ddeb60b` |
| patched staging/guard.js (v3) | `b2bef67d0a00b167711ea62fafe1e78db0f643fa9fd2069cd85ea068772fc0bb` |

Note: **guard.js checksum differs from original by design** (explicit ready/fail signal). Original Drop file remains untouched at the original hash above.

## How ready-signal + write-recheck + partial-failure work

1. **Ready signal:** `guard.js` sets `__OI_STAGING_GUARD__.status='ok'` and dispatches `oi-staging-guard-ready` only after `start()` successfully applies the existing staging restrictions. A throw in `start()` → `status='fail'` + `oi-staging-guard-fail`. Inspect never treats script `onload` as success.
2. **Default-blocked:** `#save` / `#photos` are `disabled` in HTML until the ready event enables them.
3. **Write recheck:** `stagingGuardAllowsWrites()` is called immediately before the inspection insert, before each storage upload, and before each `opening_photos` insert after upload.
4. **Partial failure:** If a later step is blocked or fails after some writes already happened, the UI shows `⚠ Partial failure:…` (not a success checkmark). Uploaded storage objects are **not** auto-deleted.

## Test matrix

Runner (runnable source shipped): `/workspace/oi_staging/patches/test/run-tests.mjs`  
Results: `/workspace/oi_staging/patches/test/results.json`  

**Honest scope:** tests are **mocked/jsdom** — **no live writes or database-permission bypass were tested.**

| # | Case | Result |
|---|---|---|
| A1 | **Actual guard initialization throwing** → Inspect stays disabled; zero-write gate | **PASS** |
| A2 | Successful guard init → explicit ready/ok; notice + UI restrictions preserved | **PASS** |
| B1 | Guard absent/missing → zero writes; default-blocked; no onload success path | **PASS** |
| B2 | Guard pending → zero writes; controls blocked | **PASS** |
| B3 | Guard fail status → zero writes; controls blocked | **PASS** |
| C1 | **After upload, before photo-record insert** gate fail → partial-failure (not success); no auto-delete | **PASS** |
| C2 | **Failure during upload** (2nd of 2) → partial-failure (not success); no auto-delete | **PASS** |
| D1 | Successful init + save + photo path (mocked) | **PASS** |
| P1–P4 | Portal missing URL / reject / onerror / success | **PASS** |
| S1–S13 | bound-review, no getPublicUrl, staging ref, no prod ref, no secrets, original Drop checksums, guard changed+orig intact, default-disabled, no onload-as-success | **PASS** |

**Summary: 25/25 PASS** (includes the gaps Stephan named: init throw, pending/missing, mid-upload / post-upload-before-insert failure, and success).

## Explicit non-actions

- NOT deployed to Netlify
- NO credential / permission / RLS / policy / production changes
- NO migrations applied
- Importer NOT enabled
- opening-photos bucket NOT made public
- NO live Supabase writes; NO DB permission bypass testing
- `RPC_AUTH_READONLY.md` NOT re-verified (left unchanged)

## Ready for

Stephan review before any Drop re-upload / Netlify deploy.
