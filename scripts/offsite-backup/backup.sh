#!/usr/bin/env bash
# SEC-1 nightly/manual off-site backup: oi-production DB + media → Cloudflare R2.
# Reads secrets from the environment (GitHub Actions). Never echoes secret values.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

WORK="${SEC1_WORK_DIR:-$(mktemp -d /tmp/sec1-backup.XXXXXX)}"
DATE_STAMP="${SEC1_DATE_STAMP:-$(today_phoenix)}"
MONTH_STAMP="${SEC1_MONTH_STAMP:-$(month_stamp_phoenix)}"
MEDIA_BUCKET="${OI_PROD_MEDIA_BUCKET:-$DEFAULT_MEDIA_BUCKET}"
SNAPSHOT_PREFIX="snapshots/${DATE_STAMP}"
MONTHLY_PREFIX="monthly/${MONTH_STAMP}"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

assert_production_only
require_env BACKUP_ENCRYPTION_KEY
require_env OI_PROD_SUPABASE_URL
require_env OI_PROD_SUPABASE_SERVICE_ROLE_KEY
configure_r2_aws_cli

mkdir -p "$WORK/db" "$WORK/storage" "$WORK/out/db" "$WORK/out/storage"
export WORK MEDIA_BUCKET

log "dumping database (custom format) for $ALLOWED_PROJECT_REF"
pg_dump --format=custom --no-owner --no-acl \
  --dbname="$OI_PROD_DATABASE_URL" \
  --file="$WORK/db/oi-production.dump"

PLAIN_SHA="$(sha256_file "$WORK/db/oi-production.dump")"
log "encrypting database dump"
encrypt_file "$WORK/db/oi-production.dump" "$WORK/out/db/oi-production.dump.enc"
ENC_SHA="$(sha256_file "$WORK/out/db/oi-production.dump.enc")"
printf '%s  db/oi-production.dump.enc\n' "$ENC_SHA" > "$WORK/out/db/oi-production.dump.enc.sha256"
printf '%s  plaintext-oi-production.dump\n' "$PLAIN_SHA" > "$WORK/out/db/oi-production.dump.plaintext.sha256"

log "listing storage objects in $MEDIA_BUCKET"
python3 - <<'PY' > "$WORK/storage-list.json"
import json, os, urllib.request
url = os.environ["OI_PROD_SUPABASE_URL"].rstrip("/") + "/storage/v1/object/list/" + os.environ["MEDIA_BUCKET"]
req = urllib.request.Request(
    url,
    data=json.dumps({"prefix": "", "limit": 1000, "offset": 0}).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["OI_PROD_SUPABASE_SERVICE_ROLE_KEY"],
        "apikey": os.environ["OI_PROD_SUPABASE_SERVICE_ROLE_KEY"],
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as resp:
    print(resp.read().decode())
PY

OBJECT_COUNT="$(python3 -c 'import json,os; items=json.load(open(os.environ["WORK"]+"/storage-list.json")); print(len(items) if isinstance(items, list) else 0)')"
log "storage list returned $OBJECT_COUNT entries (folders+files)"

log "downloading storage objects"
python3 - <<'PY'
import json, os, pathlib, urllib.request
work = pathlib.Path(os.environ["WORK"])
items = json.load(open(work / "storage-list.json"))
base = os.environ["OI_PROD_SUPABASE_URL"].rstrip("/")
bucket = os.environ["MEDIA_BUCKET"]
key = os.environ["OI_PROD_SUPABASE_SERVICE_ROLE_KEY"]
out = work / "out" / "storage"
out.mkdir(parents=True, exist_ok=True)
n = 0
for item in items if isinstance(items, list) else []:
    name = item.get("name")
    meta = item.get("metadata") or {}
    if not name:
        continue
    if item.get("id") is None and not meta.get("size") and "." not in name:
        continue
    path = name
    dest = out / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"{base}/storage/v1/object/{bucket}/{path}"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "apikey": key})
    try:
        with urllib.request.urlopen(req, timeout=300) as resp, open(dest, "wb") as f:
            f.write(resp.read())
        n += 1
    except Exception as e:
        print(f"skip/fail {path}: {type(e).__name__}", flush=True)
print(f"downloaded {n} objects", flush=True)
PY

log "building manifest.sha256"
(
  cd "$WORK/out"
  find . -type f ! -name 'manifest.sha256' ! -name 'run.json' -print0 \
    | sort -z \
    | xargs -0 -r sha256sum \
    | sed 's|  \./|  |' > manifest.sha256
)

STORAGE_BYTES="$(find "$WORK/out/storage" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
STORAGE_FILES="$(find "$WORK/out/storage" -type f 2>/dev/null | wc -l | tr -d ' ')"

python3 - <<PY > "$WORK/out/run.json"
import json, os, datetime
print(json.dumps({
  "schema": "oi-sec1-backup-v1",
  "project_ref": "$ALLOWED_PROJECT_REF",
  "media_bucket": "$MEDIA_BUCKET",
  "date_stamp_phoenix": "$DATE_STAMP",
  "created_at_utc": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
  "db_plaintext_sha256": "$PLAIN_SHA",
  "db_ciphertext_sha256": "$ENC_SHA",
  "storage_file_count": int("$STORAGE_FILES"),
  "storage_bytes": int("$STORAGE_BYTES"),
  "github_run_id": os.environ.get("GITHUB_RUN_ID"),
  "github_sha": os.environ.get("GITHUB_SHA"),
}, indent=2))
PY

log "uploading snapshot to s3://$R2_BUCKET/$SNAPSHOT_PREFIX/"
r2_sync_dir "$WORK/out/db" "$SNAPSHOT_PREFIX/db"
if [[ "$STORAGE_FILES" != "0" ]]; then
  r2_sync_dir "$WORK/out/storage" "$SNAPSHOT_PREFIX/storage"
fi
r2_cp "$WORK/out/run.json" "$SNAPSHOT_PREFIX/run.json"
r2_cp "$WORK/out/manifest.sha256" "$SNAPSHOT_PREFIX/manifest.sha256"

DAY_NUM="$(TZ=America/Phoenix date +%d)"
if [[ "$DAY_NUM" == "01" || "${SEC1_FORCE_MONTHLY:-}" == "1" ]]; then
  log "also writing monthly snapshot $MONTHLY_PREFIX"
  r2_sync_dir "$WORK/out/db" "$MONTHLY_PREFIX/db"
  if [[ "$STORAGE_FILES" != "0" ]]; then
    r2_sync_dir "$WORK/out/storage" "$MONTHLY_PREFIX/storage"
  fi
  r2_cp "$WORK/out/run.json" "$MONTHLY_PREFIX/run.json"
  r2_cp "$WORK/out/manifest.sha256" "$MONTHLY_PREFIX/manifest.sha256"
fi

log "retention: best-effort delete of snapshots older than 30 days"
python3 - <<'PY'
import os, subprocess, datetime
endpoint = os.environ["R2_ENDPOINT"]
bucket = os.environ["R2_BUCKET"]
try:
    out = subprocess.check_output([
      "aws", "s3", "ls", f"s3://{bucket}/snapshots/", f"--endpoint-url={endpoint}"
    ], text=True, stderr=subprocess.DEVNULL)
except subprocess.CalledProcessError:
    print("no snapshots listing yet", flush=True)
    raise SystemExit(0)
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)).date()
for line in out.splitlines():
    parts = line.split()
    if len(parts) < 2:
        continue
    name = parts[-1].rstrip("/")
    try:
        d = datetime.date.fromisoformat(name)
    except ValueError:
        continue
    if d < cutoff:
        prefix = f"snapshots/{name}/"
        print(f"attempt retention delete {prefix}", flush=True)
        subprocess.run([
          "aws", "s3", "rm", f"s3://{bucket}/{prefix}", "--recursive",
          f"--endpoint-url={endpoint}"
        ], check=False)
PY

log "backup complete: $SNAPSHOT_PREFIX (storage_files=$STORAGE_FILES)"
