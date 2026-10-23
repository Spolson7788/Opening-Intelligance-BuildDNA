# Read-only RPC / Auth inspection — staging only

**Project:** `fadihkhdwpfffpelqjtg` only. Production `ytqiulxtiharrplqnuir` never queried.  
**Method:** user-Supabase MCP `execute_sql` (SELECT/catalog), `get_advisors` type=security, `list_tables`, `describe_tables`.  
**No** apply_migration, DDL, GRANT/REVOKE, or Auth setting changes.

---

## A) SECURITY DEFINER / schedule-import RPCs

### Call chain (verified)

`public.oi_apply_schedule_batch` (**SECURITY INVOKER**, owner postgres)  
→ `oi_staging_private.apply_schedule` (**SECURITY DEFINER**) — requires `oi_staging_private.allowed(p_facility)` else `staging_actor_required`  
→ `oi_schedule_private.apply` (**SECURITY DEFINER**) — disable/auth checks below

### `oi_schedule_private.apply` — disable / auth checks (prosrc excerpts)

Owner: postgres · `search_path=""` · prosecdef=true

```
IF actor IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
IF NOT EXISTS(SELECT 1 FROM oi_schedule_private.settings WHERE enabled AND environment='staging' AND deployed_build=p_build) THEN RAISE EXCEPTION 'staging_import_disabled'; END IF;
-- memberships admin FOR SHARE → facility_admin_required
IF NOT EXISTS(... review_permits ... payload_sha256=digest AND deployed_build=p_build) THEN RAISE EXCEPTION 'reviewed_payload_required'; END IF;
-- read_access FOR SHARE → schedule_access_required
```

So import is gated by **settings.enabled + environment='staging' + matching deployed_build**, plus auth, admin, review permit, and read access.

### EXECUTE grants (anon / authenticated / service_role)

| Function | DEFINER? | anon | authenticated | service_role |
|---|---|---|---|---|
| `public.oi_apply_schedule_batch` | **false** (INVOKER) | no | **yes** | **yes** |
| `oi_staging_private.apply_schedule` | true | no | **yes** | no |
| `oi_schedule_private.apply` | true | no | no | no |
| `public.oi_review_opening` | true | no | **yes** | **yes** |
| `oi_schedule_private.review_opening_original` | true | no | no | **yes** |
| `public.oi_schedule_review_queue` | true | no | **yes** | **yes** |
| `public.oi_manage_opening` | true | no | **yes** | **yes** |
| `public.oi_opening_admin_queue` | true | no | **yes** | **yes** |
| `public.oi_create_qa_qr_fixture` | true | no | **yes** | **yes** |

`oi_schedule_private.apply` is not directly executable by anon/authenticated/service_role (only reachable via DEFINER chain). Public apply RPC is INVOKER but ends in DEFINER that raises `staging_import_disabled` when settings.enabled is false.

### Related review DEFINER notes

`oi_schedule_private.review_opening_original` locks `review_settings WHERE enabled` and raises `review_disabled` if missing; also requires staging actor/scope, confirmed email, facility admin, and `can_review` on read_access.

---

## B) Auth leaked-password protection

**Verified via `get_advisors` (security):** lint `auth_leaked_password_protection`, level **WARN** — “Leaked Password Protection Disabled”. Remediation: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection  

**Could-not-inspect:** Auth dashboard toggles / GoTrue config beyond what advisors surface — no Auth settings were changed.

---

## C) opening-photos bucket

**Verified** (`storage.buckets`):

| id | public | file_size_limit | allowed_mime_types |
|---|---|---|---|
| opening-photos | **false** (private) | 5242880 | image/jpeg, image/png, image/webp |

Only one bucket in staging. Not made public by this work.

---

## D) review_settings / importer flags

**Verified rows:**

| Table | Key facts |
|---|---|
| `oi_schedule_private.settings` | `enabled=false`, `environment=staging`, `project_ref=fadihkhdwpfffpelqjtg`, `deployed_build=435f5d9b01f39bd19df925f47f52da4cbaeb00964de434cd90b58a46db60e0c3` |
| `oi_schedule_private.review_settings` | `enabled=true` (singleton) |
| `oi_staging_private.scope` | `project_ref=fadihkhdwpfffpelqjtg`, `facility_id=8664b86a-af6d-444d-835a-16aa085f246e` |

**Importer is disabled** (`settings.enabled=false` → apply path raises `staging_import_disabled`). Review path remains enabled at the settings-row level.

---

## E) High-severity security advisors still open

`get_advisors` security results on staging — **no ERROR/HIGH findings**. Open items:

| Level | Lint | Count / detail |
|---|---|---|
| **WARN** | `auth_leaked_password_protection` | Leaked password protection disabled |
| **WARN** | `authenticated_security_definer_function_executable` | 5 functions: `oi_create_qa_qr_fixture`, `oi_manage_opening`, `oi_opening_admin_queue`, `oi_review_opening`, `oi_schedule_review_queue` |
| **INFO** | `rls_enabled_no_policy` | 6 private tables (`oi_schedule_private.*` ×4, `oi_staging_private.*` ×2) — RLS on, no policies (expected if access is DEFINER-only) |

---

## Verified vs could-not-inspect

| Item | Status |
|---|---|
| Schedule apply DEFINER chain + staging_import_disabled / reviewed_payload_required | Verified |
| EXECUTE grants anon/authenticated/service_role | Verified |
| settings.enabled=false (importer off) | Verified |
| review_settings.enabled=true | Verified |
| opening-photos public=false | Verified |
| Auth leaked-password advisory (WARN) | Verified via advisors |
| Auth GoTrue config / enable-toggle UI state beyond advisors | Could-not-inspect (read-only advisors only; not changed) |
| Production project ytqiulxtiharrplqnuir | Not touched (by design) |

