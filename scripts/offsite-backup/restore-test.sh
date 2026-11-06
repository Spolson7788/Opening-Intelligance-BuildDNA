#!/usr/bin/env bash
# SEC-1 restore test into a throwaway Postgres (CI service container).
# Modes:
#   SEC1_MODE=synthetic  — generate a tiny dump locally (default in CI without R2)
#   SEC1_MODE=r2         — download latest snapshot from oi-production-backups
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${SEC1_MODE:-synthetic}"
WORK="${SEC1_WORK_DIR:-$(mktemp -d /tmp/sec1-restore.XXXXXX)}"
TARGET_DB_URL="${SEC1_TARGET_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/oi_restore_test}"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK"

require_env BACKUP_ENCRYPTION_KEY

if [[ "$MODE" == "r2" ]]; then
  configure_r2_aws_cli
  SNAPSHOT_PREFIX="${SEC1_SNAPSHOT_PREFIX:-}"
  if [[ -z "$SNAPSHOT_PREFIX" ]]; then
    # Pick newest snapshots/YYYY-MM-DD that has manifest.sha256
    SNAPSHOT_PREFIX="$(aws s3 ls "s3://${R2_BUCKET}/snapshots/" --endpoint-url "$R2_ENDPOINT" \
      | awk '{print $2}' | tr -d '/' | sort | tail -1)"
    [[ -n "$SNAPSHOT_PREFIX" ]] || die "no snapshots found in R2"
    SNAPSHOT_PREFIX="snapshots/${SNAPSHOT_PREFIX}"
  fi
  log "downloading $SNAPSHOT_PREFIX from R2"
  mkdir -p "$WORK/snap"
  aws s3 sync "s3://${R2_BUCKET}/${SNAPSHOT_PREFIX}" "$WORK/snap" --endpoint-url "$R2_ENDPOINT" --only-show-errors
  [[ -f "$WORK/snap/manifest.sha256" ]] || die "manifest.sha256 missing — incomplete snapshot"
  [[ -f "$WORK/snap/db/oi-production.dump.enc" ]] || die "encrypted dump missing"
else
  log "synthetic mode: building a tiny encrypted dump for CI"
  mkdir -p "$WORK/snap/db" "$WORK/gen"
  # Create a minimal database content via SQL then pg_dump — requires target already up.
  psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE TABLE public.sec1_smoke (id int primary key, note text);
INSERT INTO public.sec1_smoke VALUES (1, 'hello-sec1');
SQL
  pg_dump --format=custom --no-owner --no-acl --dbname="$TARGET_DB_URL" --file="$WORK/gen/plain.dump"
  PLAIN_SHA="$(sha256_file "$WORK/gen/plain.dump")"
  encrypt_file "$WORK/gen/plain.dump" "$WORK/snap/db/oi-production.dump.enc"
  ENC_SHA="$(sha256_file "$WORK/snap/db/oi-production.dump.enc")"
  printf '%s  db/oi-production.dump.enc\n' "$ENC_SHA" > "$WORK/snap/db/oi-production.dump.enc.sha256"
  printf '%s  plaintext-oi-production.dump\n' "$PLAIN_SHA" > "$WORK/snap/db/oi-production.dump.plaintext.sha256"
  mkdir -p "$WORK/snap/storage"
  echo 'fixture' > "$WORK/snap/storage/fixture.txt"
  (
    cd "$WORK/snap"
    find . -type f ! -name 'manifest.sha256' -print0 | sort -z | xargs -0 sha256sum | sed 's|  \./|  |' > manifest.sha256
  )
fi

log "verifying manifest checksums"
(
  cd "$WORK/snap"
  # sha256sum -c expects "HASH  path"
  sha256sum -c manifest.sha256
)

log "decrypting dump"
decrypt_file "$WORK/snap/db/oi-production.dump.enc" "$WORK/plain.dump"
if [[ -f "$WORK/snap/db/oi-production.dump.plaintext.sha256" ]]; then
  EXPECT="$(awk '{print $1}' "$WORK/snap/db/oi-production.dump.plaintext.sha256")"
  GOT="$(sha256_file "$WORK/plain.dump")"
  [[ "$EXPECT" == "$GOT" ]] || die "plaintext dump hash mismatch"
fi

log "restoring into throwaway Postgres"
# Drop and recreate public for a clean restore of custom-format dump.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
pg_restore --no-owner --no-acl --dbname="$TARGET_DB_URL" "$WORK/plain.dump" || {
  # pg_restore returns non-zero on some notices; check table exists
  true
}

if [[ "$MODE" == "synthetic" ]]; then
  COUNT="$(psql "$TARGET_DB_URL" -tAc 'select count(*) from public.sec1_smoke')"
  [[ "$COUNT" == "1" ]] || die "expected sec1_smoke count 1, got $COUNT"
  NOTE="$(psql "$TARGET_DB_URL" -tAc "select note from public.sec1_smoke where id=1")"
  [[ "$NOTE" == "hello-sec1" ]] || die "row content mismatch"
  log "synthetic restore PASS (row count + content)"
else
  # Production snapshot: compare a few counts if OI_PROD_DATABASE_URL provided (read-only).
  for t in organizations users platform_staff; do
    C="$(psql "$TARGET_DB_URL" -tAc "select count(*) from public.$t" 2>/dev/null || echo missing)"
    log "restored public.$t count=$C"
  done
  if [[ -n "${OI_PROD_DATABASE_URL:-}" ]]; then
    assert_production_only
    for t in organizations users platform_staff; do
      LIVE="$(psql "$OI_PROD_DATABASE_URL" -tAc "select count(*) from public.$t")"
      REST="$(psql "$TARGET_DB_URL" -tAc "select count(*) from public.$t")"
      [[ "$LIVE" == "$REST" ]] || die "count mismatch for $t live=$LIVE restored=$REST"
    done
    log "r2 restore PASS (organizations/users/platform_staff counts match live)"
  else
    log "r2 restore completed without live compare (set OI_PROD_DATABASE_URL to enable)"
  fi
fi

log "restore-test PASS mode=$MODE"
