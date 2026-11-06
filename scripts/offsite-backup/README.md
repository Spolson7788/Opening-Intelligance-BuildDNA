# SEC-1 off-site backup scripts

Backs up **oi-production only** (`bekaxmatcvxqpjixwsqn`) to Cloudflare R2 bucket `oi-production-backups`.

## GitHub Actions secrets (names only — paste values yourself)

| Secret name | Purpose |
|---|---|
| `OI_PROD_DATABASE_URL` | Postgres URI for project `bekaxmatcvxqpjixwsqn` only |
| `OI_PROD_SUPABASE_URL` | `https://bekaxmatcvxqpjixwsqn.supabase.co` |
| `OI_PROD_SUPABASE_SERVICE_ROLE_KEY` | Service role for **read** of Storage bucket `oi-production-media` |
| `BACKUP_ENCRYPTION_KEY` | Long random passphrase for AES-256 dump encryption |
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | R2 API token access key id |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | Set to `oi-production-backups` |
| `RESEND_API_KEY` | For failure emails |
| `BACKUP_ALERT_TO` | Stephan’s alert email |
| `BACKUP_ALERT_FROM` | Optional; defaults to `noreply@mail.oipoweredbybuilddna.com` |

Never commit values. Never point these at other Supabase projects.

## Workflows

- `oi-production-offsite-backup.yml` — `workflow_dispatch` only (cron commented out).
- `oi-production-backup-restore-test.yml` — `workflow_dispatch`; modes `synthetic` or `r2`.
