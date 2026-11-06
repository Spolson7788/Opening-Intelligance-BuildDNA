#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
export BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-sec1-local-smoke-key-not-for-prod}"
TMP=$(mktemp -d)
echo 'sec1-smoke-payload' > "$TMP/plain"
encrypt_file "$TMP/plain" "$TMP/enc"
decrypt_file "$TMP/enc" "$TMP/out"
diff -u "$TMP/plain" "$TMP/out"
echo PASS encrypt/decrypt
rm -rf "$TMP"
