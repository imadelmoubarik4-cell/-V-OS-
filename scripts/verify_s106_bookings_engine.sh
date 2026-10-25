#!/usr/bin/env bash
# Runs the S106 bookings-engine acceptance against a replayed database: the
# approved settings values (online cap 4, 15-minute turnaround), the three fixed
# Bar sections (A 1-8, B 9-12, C 13-16, circular off), section-bounded non-wrapping
# contiguity, the section-contiguity validator, staff assign refusing a
# cross-section combination, and the per-day last-start derived from closing time.
# tests/sql/s106_bookings_engine.sql seeds fixtures in one transaction and rolls
# back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s106_bookings_engine.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then
  echo "s106_bookings_engine: passed"
else
  echo "s106_bookings_engine: FAILED" >&2
  exit 1
fi
