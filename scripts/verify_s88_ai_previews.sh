#!/usr/bin/env bash
# Runs the S88 Atlas AI preview-only acceptance script against a replayed
# database. The script seeds fixtures inside one transaction, prints a JSON
# verdict and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
status=0
for script in \
  verify_s88_ai_preview.sql \
  verify_s88_ai_signals_preview.sql \
  verify_s88_ai_hardening_preview.sql; do
  result="$(psql -v ON_ERROR_STOP=1 -X -At -f "$ROOT/scripts/$script" | grep '^{' | tail -1)"
  echo "$script: $result"
  if ! grep -q '_preview": "passed"' <<<"$result"; then status=1; fi
done
exit "$status"
