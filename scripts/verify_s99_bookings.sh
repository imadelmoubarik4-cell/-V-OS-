#!/usr/bin/env bash
# Runs the S99 Bookings database/authorization acceptance against a replayed database:
# booking tables and RPCs are sealed from browser roles; a bartender cannot configure the
# room; the atomic check-and-reserve confirms a booking to a specific table and rejects a
# second overlapping booking on that table; auto-assign falls through to the next free
# table; a large party stays 'requested' with no allocation and is confirmed only once a
# table is assigned; cancelling releases the table; the status lifecycle enforces allowed
# transitions; role forgery and inactive profiles fail closed. tests/sql/s99_bookings.sql
# seeds fixtures in one transaction and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s99_bookings.sql" 2>&1)"
echo "$output"
if grep -q 'all authorization and integrity checks passed' <<<"$output"; then
  echo "s99_bookings: passed"
else
  echo "s99_bookings: FAILED" >&2
  exit 1
fi
