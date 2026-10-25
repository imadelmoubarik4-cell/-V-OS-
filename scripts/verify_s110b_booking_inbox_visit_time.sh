#!/usr/bin/env bash
# Runs the S110b booking inbox visit-time acceptance against a replayed database:
# each inbox row carries its reservation's visit start and venue-local date (null
# when unlinked); the S109 keys, manager gate and browser-role seal are unchanged.
# tests/sql/s110b_booking_inbox_visit_time.sql seeds fixtures in one transaction and
# rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s110b_booking_inbox_visit_time.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then
  echo "s110b_booking_inbox_visit_time: passed"
else
  echo "s110b_booking_inbox_visit_time: FAILED" >&2
  exit 1
fi
