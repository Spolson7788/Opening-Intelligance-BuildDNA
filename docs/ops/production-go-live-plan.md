# Production go-live plan

This is a plan only. It does not publish, does not change a hosted database, and does not set or print any secret. `npm run migrate` refuses `oi-production` (`bekaxmatcvxqpjixwsqn`) because that command would apply every pending file. Do not bypass that refusal. Do not apply this list until each file has its own approval.

Read on 2026-11-12, names only:

- Production database `oi-production` (`bekaxmatcvxqpjixwsqn`). Ledger table `public.schema_migrations` has `filename` and `applied_at` only. It has no `sha256` column. 45 filenames are recorded. The last filename in sort order is `20261103230000_production_access_rules.sql`.
- That last filename is not a file in this repository. Do not recreate it from memory.
- Staging database `oi-video-workflows-staging` (`boaoedvyvifppuklbwad`). Its ledger has 35 filenames and does include `20261111210000_company_dashboard_phase2.sql`. It is not a superset of production. Do not replay staging onto production.
- Production Netlify site `oi-production` is `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01`. Staging Netlify site `oi-video-workflows-staging` is `b64bf33c-a131-4ae2-b2b0-9aec16e9f77b`.

## a. Repo migrations after production's last recorded filename

Order is filename order, which is the order `scripts/migrate.js` would use. The range starts after `20261103230000_production_access_rules.sql` and ends at `20261111210000_company_dashboard_phase2.sql`. SHA-256 is of the file bytes in this commit. "Additive" here means the file does not `DELETE` or `TRUNCATE` customer rows. A `DROP TRIGGER IF EXISTS` or `DROP POLICY IF EXISTS` that is immediately recreated is called out. It is still not a license to apply the file.

Production already has `public.staff_mfa_factors` and `public.password_reset_tokens` even though `20261107130500_staff_mfa.sql` and `016_password_reset.sql` are not ledger rows. Production does not have `public.inspection_visits` or `public.provider_accounts`. A missing ledger row does not mean the objects are absent. Read the live table before applying a file.

| Order | File | SHA-256 | Effect | Rollback file |
| --- | --- | --- | --- | --- |
| 1 | `migrations/20261107130500_staff_mfa.sql` | `82af74887ded9753fa0543eac72858740f5d8ede51aa65d6d4b2b48f3ef48ba6` | Additive. Creates staff MFA tables with `IF NOT EXISTS`. The header says not to apply it with `npm run migrate`. The factors table already exists on production, so a blind re-apply can still fail on policies or grants. | `docs/rollback/20261107130500_staff_mfa_rollback.sql` |
| 2 | `migrations/20261107143000_staff_sign_in_codes.sql` | `8f0a78b0672f56820f3ef3d108e90e465baaf86da65754d20e6227ab1870814a` | Additive. Adds the sign-in code table and grants. | `docs/rollback/20261107143000_staff_sign_in_codes_rollback.sql` |
| 3 | `migrations/20261107203000_door_hardware_recognition.sql` | `7c8bf85f667b672fbdd663149018fd5ff6c65c9fd96c70a27a4c878e95fa4e63` | Additive. Recognition tables and grants. The production Netlify function leaves recognition off. | `docs/rollback/20261107203000_door_hardware_recognition_rollback.sql` |
| 4 | `migrations/20261108143000_purchasing_department_email.sql` | `072da760889c3ee36b577423f23c158d48b02243497666cb48422d12032496f3` | Additive. Purchasing email column. | None in `docs/rollback/` |
| 5 | `migrations/20261108143100_nfpa80_fire_door_inspections.sql` | `e18836c42f57f5ca2660ea085cd1994963bd888c7cda9f1307304ee15ef2aa17` | Additive for rows. Adds deficiency tables, `photos.inline_bytes`, and replaces three `BEFORE DELETE` triggers so early deletes of inspection evidence fail. That trigger change can block a delete that works today. | None in `docs/rollback/` |
| 6 | `migrations/20261108150000_inspector_license_and_facility_contact.sql` | `89e8a66a1a7695714cb1450095e80f85ef6395d800566b01ee0a0a130f603a71` | Additive. Inspector license and facility contact columns. | None in `docs/rollback/` |
| 7 | `migrations/20261108160000_inspection_report_records.sql` | `49bb2a99d8de97bb02e6910670d95fb178aa8f719f3e740b31cf0fde0f1e0806` | Additive. Inspection report record columns. | None in `docs/rollback/` |
| 8 | `migrations/20261108171000_fire_door_api_policies.sql` | `9067907cc36da04bbbb81a6c0bdf394e351c997474af36eec6dfcc6a12439dc4` | Additive policies and grants for the API role. No row deletes. | None in `docs/rollback/` |
| 9 | `migrations/20261108180000_purchasing_api_policies.sql` | `8ca3b0dc265e0c2a8cb3fda63d0359498408f2a91ebc4cb59d40600452fea6a4` | Additive policies. Includes `DELETE` policies for the API role on purchasing tables. That allows later deletes. This file itself does not delete rows. | None in `docs/rollback/` |
| 10 | `migrations/20261108181500_purchasing_api_insert_policies.sql` | `9646b952dfd5c761eb8071047b1c639083c4d51d68aa27e1313583de647ae7aa` | Additive insert policies. | None in `docs/rollback/` |
| 11 | `migrations/20261109170000_inspection_visits.sql` | `a5978c259b16381cbb55ce921ee4898846ee13174c7d30d12c8c1e0d0e74ddc0` | Additive. Creates `inspection_visits` and adds `inspection_events.visit_id`. The header still says draft and not applied. Production does not have the table. | None in `docs/rollback/` |
| 12 | `migrations/20261109173000_inspection_visit_official_pdf.sql` | `01e152606e4174ef4b665635caafcf511a04ca5f68321c4db8249da83fb59eb6` | Additive columns for the stored visit PDF key and hash. Header says draft. | None in `docs/rollback/` |
| 13 | `migrations/20261109190000_inspection_visits_policies.sql` | `f2ff2d26f3f24532c9e7b85d6e0181331ac4153ce04e76e76f318c2de8544ee5` | Drops and recreates the API policies on `inspection_visits` if they exist, then grants. No customer-row delete. | None in `docs/rollback/` |
| 14 | `migrations/20261111210000_company_dashboard_phase2.sql` | `7f184d39cde7b4fa2f8ea64a28ed28d1f3c4cfcf03fd48077a08e6d6926a6fb2` | Additive tables and columns, plus backfill `INSERT`s that classify existing sites into provider accounts. It does not delete openings or estimates. Approved for staging only. Production does not have `provider_accounts`. | `docs/rollback/20261111210000_company_dashboard_phase2_rollback.sql` |

### Gaps behind the last recorded filename

These repo files sort before `20261103230000_production_access_rules.sql` and are not rows in the production ledger. They are not in the apply list above. Do not insert them into the middle of a later run without a separate review. Production already has `password_reset_tokens` and `staff_mfa_factors`, so part of this work may already be present under another change.

- `migrations/016_password_reset.sql`
- `migrations/20261030090700_recognition_runs.sql`
- `migrations/20261030090800_recognition_budget_guard.sql`
- `migrations/20261030090900_recognition_revoke_public_access.sql`
- `migrations/20261030091000_reference_library.sql`
- `migrations/20261031090000_recognition_run_records.sql`

Staging's ledger is also missing most of those names, and it is missing every file in the table above except phase 2. The visit, deficiency, MFA, and provider-account tables do exist on staging. The staging ledger is not a complete history of the staging schema.

## b. Environment names for field, facility dashboard, and company dashboard

Names only. No values belong in this file or in git. Netlify injects `DEPLOY_URL`, `DEPLOY_PRIME_URL`, and `URL`. `netlify.toml` sets `NODE_ENV` to `production` for the production context and `NODE_VERSION` to `24`.

A live dump of the staging Netlify environment was not taken for this plan. The staging publisher records that `OI_MEASUREMENT_READER` is already set on staging and that an approved publish skips writing it. The same publisher only checks whether `OI_RECOGNITION_ENABLED` and `ANTHROPIC_API_KEY` are present. It does not record that result in git. Do not copy staging values into production.

| Name | Need | Staging |
| --- | --- | --- |
| `DATABASE_URL` | Required. API will not serve field, facility dashboard, or company dashboard data without it. Production must be `oi-production` (`bekaxmatcvxqpjixwsqn`). | Staging site uses the staging project `boaoedvyvifppuklbwad`. |
| `JWT_SECRET` | Required. Sessions fail closed when it is unset. | Required on staging as well. Presence was not re-read. |
| `S3_BUCKET` | Required for inspection photos and visit PDFs. | Staging uses the private bucket `oi-video-workflows-media`. Production's existing private bucket is `oi-production-media`. |
| `S3_REGION` | Required with the bucket. | Presence was not re-read. |
| `S3_ACCESS_KEY_ID` | Required with the bucket. | Presence was not re-read. |
| `S3_SECRET_ACCESS_KEY` | Required with the bucket. | Presence was not re-read. |
| `S3_ENDPOINT` | Optional. Set only for an S3-compatible endpoint. Unset means AWS S3. | Unknown in this plan. |
| `S3_PUBLIC_BASE_URL` | Optional. Leave unset for private objects. Setting it publishes a public base URL. | Unknown in this plan. |
| `CORS_ORIGINS` | Optional. Empty accepts any browser origin and logs a warning. Set it to the production site origin before go-live. | Unknown in this plan. |
| `OI_FIELD_APP_URL` | Required for QR links that must open the field app on the production host. | Staging tests use a staging field URL. The live value was not re-read. |
| `RESEND_API_KEY` | Required for password-reset and staff sign-in mail. Field sign-in still works without mail. Reset and emailed codes do not. | Unknown in this plan. |
| `PASSWORD_RESET_FROM_EMAIL` | Required for that mail. | Unknown in this plan. |
| `PASSWORD_RESET_PUBLIC_URL` | Required for reset links. | Unknown in this plan. |
| `STAFF_MFA_ENCRYPTION_KEY` | Required only if staff MFA is turned on. Customers are not given MFA by that migration. | Unknown in this plan. |
| `GOOGLE_MAPS_API_KEY` | Optional. Not approved. When unset, Today's route uses the straight-line estimate. Do not add it as part of go-live. | Not approved for staging either. The r59 publisher does not set it. |
| `OI_RECOGNITION_ENABLED` | Required for launch. Non-secret flag. Required value: `true`. Claude photo recognition and the Measure reader both refuse the call when this is not `true`. | Checked by name on staging. Do not copy the secret that sits beside it. |
| `OI_MEASUREMENT_READER` | Required for launch. Non-secret flag. Required value: `anthropic`. That selects the Claude Measure reader. | Staging already has this name. Do not copy the staging value into git. The launch value is `anthropic`. |
| `ANTHROPIC_API_KEY` | Required for launch. Secret. Claude-primary recognition runs and the Measure reader both use it. Name only. No value in git. | Present on staging by name. Do not copy the value. |
| `OI_MEASUREMENT_READER_MODEL` | Optional. Non-secret. Unset uses `claude-sonnet-4-5-20250929`, the same model the Claude recognition runs use. | Unknown in this plan. |
| `ROBOFLOW_API_KEY` | Not required for Claude-primary recognition or the Measure reader. Required only for the Roboflow door-hardware identify path. Leave it unset for this launch. Secret if it is ever set. | Present on staging by name. Do not copy it. |
| `OI_COMMERCIAL_STORAGE_API_KEY` | Stay off. Not used by Claude recognition or Measure. | Present on staging by name. Do not copy it. |
| `OI_STORAGE_IDENTITY_EMAIL` | Stay off. Storage identity is the commercial-storage path, not Claude. | Present on staging by name. Do not copy it. |
| `OI_STORAGE_IDENTITY_PASSWORD` | Stay off. Secret. Same commercial-storage path. | Present on staging by name. Do not copy it. |
| `OI_STORAGE_IDENTITY_USER_ID` | Stay off. Same commercial-storage path. | Present on staging by name. Do not copy it. |
| `OI_PROVIDER_ESTIMATES_ENABLED` | Stay off. Staging-only commercial input. | Present on staging by name. |
| `OI_FACILITY_BUDGET_ENABLED` | Stay off. Staging-only commercial input. | Present on staging by name. |
| `SITE_ID` | Optional. Used by the photo-deletion schedule to confirm the site. | Unknown in this plan. |

## c. Storage for visit PDFs and inspection photos

The API stores both in the one private S3 bucket from `S3_BUCKET`. It does not use a public URL when `S3_PUBLIC_BASE_URL` is unset.

- Inspection photo key: `private/org/{organizationId}/opening/{openingId}/photo/{photoId}.{ext}`
- Visit PDF key: `private/org/{organizationId}/facility/{propertyId}/inspection-visit/{visitId}.pdf`

The PDF key is saved on `inspection_visits.report_storage_key`. That column does not exist on production until `20261109170000` and `20261109173000` are applied. Photos already use the private key prefix in the app. Production's bucket `oi-production-media` exists and is not public. It has no `storage.objects` or `storage.buckets` policies. The app's S3 client uses the access key, which bypasses Supabase Storage RLS when the endpoint is Supabase. The protection is a private bucket plus a key that can only put and get the prefixes above.

Staging bucket `oi-video-workflows-media` is private and has the technical-user policies in `docs/engineering/storage-technical-identity-REVIEW-ONLY.sql`. Those policies allow one placeholder user to upload only `commercial-documents/v1/{uuid}.pdf`. They do not authorize visit PDFs or inspection photos. Do not copy them onto `oi-production-media`.

What production needs before visit PDFs and new inspection photos:

1. Keep `oi-production-media` private.
2. Point `S3_BUCKET` at that bucket and set the region and access key. Do not set `S3_PUBLIC_BASE_URL`.
3. Allow that key to put and get the two prefixes above, and to head an object the API just wrote.
4. Do not add a public Storage policy.
5. Apply the visit-table migrations before storing a visit PDF. Photos can use the existing photo path only if the photo tables production already has match the key the app writes.

## d. Privacy gate and `sso_login`

The staging publisher treats an HTTP 401 whose body is HTML as the Netlify privacy gate, not as the app's own login refusal. A gated 401 is not a successful publish check. The staging instructions say not to turn that gate off.

`sso_login` is the Netlify site setting that puts the site behind the team sign-in gate. This repository does not change it. For a public go-live of field, facility dashboard, and company dashboard, production `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01` has to be reachable without that HTML 401. The change, only after a separate approval, is to set the production site's `sso_login` to false. Do this in the Netlify site settings or with a site update for that site id only. Do not change the staging site.

Revert: set `sso_login` back to true on the production site only. The previous deploy stays in place. Visitors get the HTML 401 again. The app's own accounts are unchanged. Do not delete the deploy to undo the gate.

This plan did not read or change the current production `sso_login` value.

## e. Production publish command

`scripts/artifact-publisher-staging-16abbf4.mjs` refuses production. Its only publish command is `node scripts/artifact-publisher-staging-16abbf4.mjs --publish-approved`, and that command is locked to the staging site. Do not point it at production. Do not remove the production refusal. Do not add a flag that selects the site.

A production publisher is not built here. What a later, separately approved script would need:

1. A new file, not an edit that lets the staging script accept `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01`.
2. A hard-coded production site id, and a refusal of the staging site and every other id.
3. Its own pin, its own journal directory, and its own `--publish-approved`. Default remains a dry run.
4. Record the production site's current published deploy as the rollback before any upload. Do not reuse the staging rollback deploy `6af230ff9978904131f1329d`.
5. No `npm run migrate` inside the publisher. Database files stay a separate approved step.
6. No write of `GOOGLE_MAPS_API_KEY`. No copy of staging secret values.
7. A written approval that names the pin before `--publish-approved` is run. This document is not that approval.

`scripts/artifact-publisher-production.mjs` is that separate script. It refuses every mode unless `--approve-production-site b4e0fc62-86ce-4a26-9ebf-26d7386f4b01` is present. It refuses the staging site id. It does not contain the visitor-gate setting name and does not change that setting. It does not write environment variables. The upload path matches the staging publisher: digest and file-list checks, `--upload-check`, a dry run when `--publish-approved` is absent, one `--publish-approved`, and read-only `--diagnose` / `--check-deploy`. It records the live production deploy as the rollback. It does not reuse the staging rollback deploy. The app pin is `bc7c4b975a5e7a694dbe2ad8208f7bc323eb8b71`. A journal template is `docs/ops/production-publish-journal-template.json`. The script writes a real journal under `dist/production-publish-journal` only when someone runs it. Do not run it from this commit. Do not pass `--publish-approved`.

## f. Rollback, in step order

Do the steps in this order. Roll back in reverse. Stop on the first failure.

1. Database, one file at a time, only with approval. Before each file, confirm the objects are absent or that the file is idempotent. After each file, record the filename in `schema_migrations` yourself. Do not use `npm run migrate`.
   - Roll back a file only with its rollback script when one is listed above, and only with a separate approval. The phase 2 rollback drops the new account, route, and pickup tables and the new columns. It does not delete openings. Files with no rollback script stay in place; do not invent a `DROP` during an incident.
   - The NFPA delete triggers are the risky behavior change. Rolling them back means restoring the previous trigger, which this repo does not contain. Do not drop the triggers to "undo" them unless a reviewed script says so.
2. Storage. Confirm the private bucket and key. Rollback is to stop new writes. Do not delete `oi-production-media` or the objects already stored.
3. Environment. Add a name only when that step needs it. Rollback is to remove the name you added, or set it back to the previous value that was recorded outside git. Do not add `GOOGLE_MAPS_API_KEY`.
4. Privacy gate. Open `sso_login` only when the app is ready for customers. Rollback is `sso_login` true on the production site.
5. App publish, only after a production publisher exists and a named pin is approved. Rollback is restoring the production deploy id recorded before that upload. Do not restore a staging deploy onto production.

Anything destructive or easy to get wrong:

- `npm run migrate` against production, or pointing the staging publisher at production.
- Treating the staging ledger as the list production should replay. The ledgers have diverged, and staging's ledger is missing files whose tables exist.
- Applying phase 2. It backfills account rows from existing sites. The rollback drops those new tables.
- The NFPA `BEFORE DELETE` triggers, which can block deletes of inspection evidence.
- A public bucket or `S3_PUBLIC_BASE_URL` on inspection photos and visit PDFs.
- Turning off `sso_login` before the app and database for that release are ready.
- `20261103230000_production_access_rules.sql` is on production and not in git. Do not replace it.

## Part 2 runbook

Checked against the schema-only dump of production taken 2026-11-12 07:05 MST and a local PostgreSQL 17 restore. Nothing in this commit was run against a hosted database.

Production `public.schema_migrations` has 45 rows and no `sha256`. The latest filename is `20261103230000_production_access_rules.sql`, which is not in the repo. It created 69 `prod_api_*` policies. `supabase_migrations.schema_migrations` has four rows (`016_password_reset`, staff MFA, staff sign-in codes, `sec4_function_search_path`); those objects exist. Twenty repo filenames are missing from the public ledger. Production data at the time of the executor read: 5 users, 3 organizations, 5 memberships, 16 audit rows, and 0 openings, work orders, and photos.

Do these steps only after a separate approval for each one. Stop on the first failure.

1. Restore or read the production schema. The local proof used PostgreSQL 17 and the attached schema-only dump. Do not point `DATABASE_URL` at `bekaxmatcvxqpjixwsqn` or `boaoedvyvifppuklbwad`.
2. Run `node scripts/production-schema-precheck.mjs` on that local database. It is read-only. It expects 69 `prod_api_*` policies, the password-reset and staff MFA tables, and no `provider_accounts` or `inspection_visits`.
3. Run `node scripts/apply-production-schema-bundle.mjs`. It applies `migrations/production/20261112140500_r59_production_schema.sql` in one transaction. The bundle is the 20 missing repo files, then `prod_api_select`, `prod_api_insert`, and `prod_api_update` on each new table (plus `prod_api_delete` on the two purchasing tables). It does not drop an existing `prod_api_*` policy. It inserts the 20 filenames into `public.schema_migrations`. A second run stops with `production_r59_bundle_already_applied`.
4. Run `node scripts/production-schema-postcheck.mjs`. It is read-only.
The company-deactivation addendum is `migrations/production/20261112143000_company_deactivation.sql`, with rollback `migrations/production/20261112143000_company_deactivation_rollback.sql`. It is not part of the r59 bundle and is not approved to apply on a hosted database. Apply it only on a local restore, after the r59 bundle. `scripts/apply-production-company-deactivation.mjs` refuses production and staging project refs.

5. Publish is still not this step. `scripts/artifact-publisher-production.mjs` can upload when someone later passes `--approve-production-site b4e0fc62-86ce-4a26-9ebf-26d7386f4b01` and `--publish-approved` on a clean tree at the pinned app. Do not run it from this commit. The schema bundle is still not approved.
6. Open the visitor gate only after the schema and the app deploy exist: set `sso_login` to false on site `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01` only. Revert by setting `sso_login` back to true. That restores the HTML 401 and leaves the deploy in place. Do not change the staging site. This repository does not perform that change.

Rollback of the schema is `migrations/production/20261112140500_r59_production_schema_rollback.sql`. On the local proof it returned the public tables, columns, policies, functions, triggers, and grants to the restored dump. It does not drop password-reset or staff MFA objects. It does not drop the original 69 `prod_api_*` policies.

### Environment names

Production Netlify already has: `APP_BASE_URL`, `DATABASE_URL`, `EMAIL_FROM`, `EMAIL_PROVIDER`, `EMAIL_PROVIDER_API_KEY`, `JWT_SECRET`, `OI_DATABASE_POOL_PROFILE`, `PASSWORD_RESET_FROM_EMAIL`, `PASSWORD_RESET_PUBLIC_URL`, `RESEND_API_KEY`, `S3_ACCESS_KEY_ID`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_SECRET_ACCESS_KEY`.

Missing on production and present on staging, by name only: `ANTHROPIC_API_KEY`, `CORS_ORIGINS`, `DATABASE_CA_CERT`, `NODE_ENV`, `OI_COMMERCIAL_STORAGE_API_KEY`, `OI_FACILITY_BUDGET_ENABLED`, `OI_FIELD_APP_URL`, `OI_MEASUREMENT_READER`, `OI_PROVIDER_ESTIMATES_ENABLED`, `OI_RECOGNITION_ENABLED`, `OI_STORAGE_IDENTITY_EMAIL`, `OI_STORAGE_IDENTITY_PASSWORD`, `OI_STORAGE_IDENTITY_USER_ID`, `ROBOFLOW_API_KEY`, `STAFF_MFA_ENCRYPTION_KEY`.

Photo recognition (Claude primary) and the Measure reader are approved to be on at launch. The production publisher does not set these. Set them on the production site before that launch publish. Names and non-secret values only:

Required non-secret flags:

- `OI_RECOGNITION_ENABLED` = `true`
- `OI_MEASUREMENT_READER` = `anthropic`

Required secret, name only:

- `ANTHROPIC_API_KEY`

Optional non-secret:

- `OI_MEASUREMENT_READER_MODEL`. Unset uses `claude-sonnet-4-5-20250929`.

`ROBOFLOW_API_KEY` is not required for Claude-primary recognition runs or the Measure reader. The Roboflow door-hardware identify path is the only caller. Leave `ROBOFLOW_API_KEY` unset. Storage-identity names are not required either: `OI_COMMERCIAL_STORAGE_API_KEY`, `OI_STORAGE_IDENTITY_EMAIL`, `OI_STORAGE_IDENTITY_PASSWORD`, `OI_STORAGE_IDENTITY_USER_ID`.

Staging flags that stay off for this launch: `OI_PROVIDER_ESTIMATES_ENABLED`, `OI_FACILITY_BUDGET_ENABLED`, `OI_COMMERCIAL_STORAGE_API_KEY`, `OI_STORAGE_IDENTITY_EMAIL`, `OI_STORAGE_IDENTITY_PASSWORD`, `OI_STORAGE_IDENTITY_USER_ID`, `ROBOFLOW_API_KEY`, `GOOGLE_MAPS_API_KEY`.

`netlify/functions/api.ts` now includes production site `b4e0fc62-86ce-4a26-9ebf-26d7386f4b01` on the recognition and Measure allowlist only while `OI_RECOGNITION_ENABLED` is `true` and `OI_MEASUREMENT_READER` is `anthropic`. Without those flags the routes stay off. Other site ids stay off even with the flags. The recognition tables are still in the production schema bundle, which is not approved to apply. The flags do not create those tables.

Also still needed for the rest of the app: the names production already has, plus `OI_FIELD_APP_URL` for QR links and `CORS_ORIGINS` set to the production origin. `NODE_ENV` is set by `netlify.toml` for the production context. `DATABASE_CA_CERT` only if the database connection is given a custom CA. `STAFF_MFA_ENCRYPTION_KEY` is required only if staff MFA is used. Do not copy staging values.

### Storage

`oi-production-media` is private, limited to 100 MiB, and has no storage policies. Keep it private. Do not set `S3_PUBLIC_BASE_URL`. Visit PDFs use `private/org/{organizationId}/facility/{propertyId}/inspection-visit/{visitId}.pdf`. Inspection photos use `private/org/{organizationId}/opening/{openingId}/photo/{photoId}.{ext}`. The API key needs put and get on those prefixes. Staging policies on `oi-video-workflows-media` allow one technical user to upload `commercial-documents/v1/{uuid}.pdf` only. Do not copy them onto `oi-production-media`.

### Not reversible

The NFPA migration installs `BEFORE DELETE` triggers on `inspection_events`, `fire_door_deficiencies`, and `photos`. They are new on the Nov 12 dump. Rollback drops them. It cannot restore a later hand-edited function body. While they are installed, a delete of recent inspection evidence fails. The recognition files replace `platform_audit_events_action_check` and the final list matches the Nov 12 dump. If an existing audit row uses an action outside that list, the bundle aborts and changes nothing. Phase 2 backfills account rows from existing sites. Production had 0 openings when the executor read it, so that backfill inserts nothing until sites exist. The rollback drops the new account, route, and pickup tables.
