# Offline Sync and Photo Retention — Proposed Nonproduction Manifest

Status: **PROPOSED — NOT AUTHORIZED OR PROVISIONED**  
Scope: PR #2 only  
Requested expiration/decommission date: **2026-10-19**

## Resource identities

| Resource | Exact proposed value |
|---|---|
| Supabase project name | `oi-offline-sync-pr2-nonproduction` |
| Supabase project reference | **Provider-assigned after creation authorization; not yet available** |
| Private bucket | `oi-opening-media-pr2-private` |
| API database role | `oi_pr2_api` (dedicated least-privilege nonproduction role) |
| Netlify account/team | `Elite Sales Consultants — OI Nonproduction` (proposed isolated team) |
| Netlify Functions region | `us-west-2` (proposed) |
| Runtime | Node.js 24, Netlify Functions |
| API deployment name | `oi-offline-sync-pr2-api-nonproduction` |
| API URL | `https://oi-offline-sync-pr2-api-nonproduction.netlify.app` |
| Field App origin | `https://oi-offline-sync-pr2-field-nonproduction.netlify.app` |
| Dashboard origin | `https://oi-offline-sync-pr2-dashboard-nonproduction.netlify.app` |
| Deletion scheduler | Netlify scheduled function `photo-deletion-retry`, `* * * * *` UTC |
| Evidence location | `docs/evidence/offline-sync-photo-retention/pr2-correction-2/` |

The reviewable hosting package is `netlify.toml` plus
`netlify/functions/api.ts`, its Request/Response Express adapter, and
`netlify/functions/photo-deletion-retry.ts`. The API function exposes `/health`
and `/api/*`. The scheduled function runs once per minute, claims at most 25
due jobs, stops retrying a job after eight attempts, and records finalization
against the authorized user who requested deletion. The schedule must not be
enabled before staging authorization.

The project, bucket, deployment, URL, identities, and evidence destination are
names reserved by this proposal only. Nothing in this manifest provisions or
connects them. If a provider assigns a different project reference or URL,
authorization stops until this manifest is amended and reviewed.

Creation authorization permits only creation of these isolated empty resources.
It does not authorize client connection or staging execution. After creation,
the provider-assigned Supabase reference, actual Netlify team/site IDs, region,
and generated URLs must be written into an amended manifest and approved before
any migration, identity creation, upload, or connected request.

## Isolation and credentials

- Production credentials and production resource identifiers are prohibited.
- No production Supabase project, bucket, Netlify site, database, user, or data
  may be copied, linked, or used as a fallback.
- Secrets must be stored only in the authorized nonproduction deployment secret
  store. They must never appear in Git, CI output, screenshots, test evidence,
  signed-URL captures, or exported media.
- Secure credential custodian: **Stephan Olson**.
- Evidence must contain identifiers, outcomes, timestamps, and hashes only; it
  must exclude passwords, tokens, cookies, secret keys, signed URLs, and media.

Required server-only secret names and scopes (values are never committed):

| Variable | Scope |
|---|---|
| `DATABASE_URL` | API and deletion scheduler; `oi_pr2_api` role only |
| `JWT_SECRET` | API only |
| `S3_BUCKET` | API and deletion scheduler; exact private bucket above |
| `S3_REGION` | API and deletion scheduler |
| `S3_ENDPOINT` | API and deletion scheduler; exact nonproduction storage endpoint |
| `S3_ACCESS_KEY_ID` | API and deletion scheduler |
| `S3_SECRET_ACCESS_KEY` | API and deletion scheduler |
| `CORS_ORIGINS` | API only; exact Field App and Dashboard origins above |

No `VITE_`, browser-readable, deploy-preview, or shared production scope may
contain database or storage credentials. The API must fail closed if required
server variables are absent; no production fallback is permitted.

## Test tenants and identities

All addresses use the reserved `.invalid` domain until the identities are
created through the approved secure provisioning channel.

| Tenant | Identity | Proposed email | Required state |
|---|---|---|---|
| Org A — `OI PR2 Test Alpha` | Administrator | `admin@alpha.oi-pr2.invalid` | active |
| Org A — `OI PR2 Test Alpha` | Technician | `technician@alpha.oi-pr2.invalid` | active |
| Org A — `OI PR2 Test Alpha` | Revoked technician | `revoked-technician@alpha.oi-pr2.invalid` | deactivated before revocation test |
| Org B — `OI PR2 Test Beta` | Administrator | `admin@beta.oi-pr2.invalid` | active |
| Org B — `OI PR2 Test Beta` | Technician | `technician@beta.oi-pr2.invalid` | active |

Credentials are generated at provisioning time by the credential custodian,
transmitted outside the evidence channel, and destroyed at decommission.

## Human ownership

| Responsibility | Named owner |
|---|---|
| Rollback owner | Stephan Olson |
| Backup rollback operator | Michelle Aure |
| Storage cleanup owner | Stephan Olson |

## Migration checkpoint and recovery

1. Confirm the authorized Git commit, clean worktree, successful checks, exact
   nonproduction project reference, empty private bucket, and zero production
   identifiers in configuration.
2. Export nonproduction schema-only metadata and record the pre-migration
   migration ledger, table/RLS/grant inventory, and bucket policy hash in the
   evidence folder. Do not export credentials or media.
3. Apply migrations sequentially through canonical `014_offline_sync_foundation.sql`
   and `015_harden_supabase_data_api.sql` only to the named nonproduction project.
4. Verify RLS remains enabled, `anon` and `authenticated` retain no direct access
   to internal sync tables, and the bucket is private with the configured media
   limits and content types.
5. Run tenant isolation, revoked-user, idempotency/concurrency, retrieval-proof,
   geolocation, and deletion-recovery acceptance tests.
6. On failure, stop clients and the deletion processor; preserve evidence;
   remove unconfirmed test uploads using the private-object inventory; then run
   the reviewed `015` security-preserving recovery followed by the paired `014`
   rollback only if no accepted offline records need preservation.
7. If accepted records exist, do not run destructive rollback. Restore the
   checkpoint into a fresh nonproduction project and reconcile receipts and
   private-object inventory under the rollback owner's supervision.
8. The rollback owner signs the recovery result; the backup operator verifies
   the migration ledger, RLS/grants, object inventory, and absence of secrets.

## Decommission

On **2026-10-19**, unless an extension is explicitly approved, the storage
cleanup owner must drain deletion jobs, verify the bucket inventory is empty,
revoke test sessions and credentials, export credential-free evidence, remove
the API deployment, delete the private bucket, and delete the nonproduction
Supabase project. The rollback owner and backup operator must countersign the
decommission record.
