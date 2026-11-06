#!/usr/bin/env bash
# Shared helpers for SEC-1 off-site backup. Never prints secret values.
set -euo pipefail

ALLOWED_PROJECT_REF="bekaxmatcvxqpjixwsqn"
DEFAULT_BUCKET="oi-production-backups"
DEFAULT_MEDIA_BUCKET="oi-production-media"
R2_ENDPOINT_BASE="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[sec1] $*"; }

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    die "missing required env/secret: $name"
  fi
}

assert_production_only() {
  local url="${OI_PROD_DATABASE_URL:-}"
  [[ -n "$url" ]] || die "OI_PROD_DATABASE_URL is required"
  if [[ "$url" != *"$ALLOWED_PROJECT_REF"* ]]; then
    die "refusing to run: database URL does not name allowed project ref $ALLOWED_PROJECT_REF"
  fi
  # Hard refuse known forbidden refs if ever pasted by mistake
  local forbidden=(fadihkhdwpfffpelqjtg ytqiulxtiharrplqnuir fdudsigbxumcpbxxxerb ioqfdcehnhnqpnqawwvo boaoedvyvifppuklbwad)
  local f
  for f in "${forbidden[@]}"; do
    if [[ "$url" == *"$f"* ]]; then
      die "refusing to run: database URL mentions forbidden project $f"
    fi
  done
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

encrypt_file() {
  # AES-256-CBC with PBKDF2; key from BACKUP_ENCRYPTION_KEY (passphrase).
  local src="$1" dest="$2"
  require_env BACKUP_ENCRYPTION_KEY
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$src" -out "$dest" -pass env:BACKUP_ENCRYPTION_KEY
}

decrypt_file() {
  local src="$1" dest="$2"
  require_env BACKUP_ENCRYPTION_KEY
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$src" -out "$dest" -pass env:BACKUP_ENCRYPTION_KEY
}

configure_r2_aws_cli() {
  require_env R2_ACCOUNT_ID
  require_env R2_ACCESS_KEY_ID
  require_env R2_SECRET_ACCESS_KEY
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="${R2_REGION:-auto}"
  export R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export R2_BUCKET="${R2_BUCKET:-$DEFAULT_BUCKET}"
}

r2_cp() {
  local src="$1" key="$2"
  aws s3 cp "$src" "s3://${R2_BUCKET}/${key}" --endpoint-url "$R2_ENDPOINT" --only-show-errors
}

r2_sync_dir() {
  local src="$1" prefix="$2"
  aws s3 sync "$src" "s3://${R2_BUCKET}/${prefix}" --endpoint-url "$R2_ENDPOINT" --only-show-errors
}

r2_ls_prefix() {
  local prefix="$1"
  aws s3 ls "s3://${R2_BUCKET}/${prefix}" --endpoint-url "$R2_ENDPOINT" || true
}

r2_rm_prefix() {
  # Best-effort retention cleanup. Bucket locks may block deletes; that is OK.
  local prefix="$1"
  aws s3 rm "s3://${R2_BUCKET}/${prefix}" --recursive --endpoint-url "$R2_ENDPOINT" || \
    log "retention delete skipped or partially blocked for $prefix (locks expected)"
}

today_phoenix() {
  TZ=America/Phoenix date +%F
}

month_stamp_phoenix() {
  TZ=America/Phoenix date +%Y-%m-01
}
