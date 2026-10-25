#!/usr/bin/env bash
# Runs the S110 booking seat-integrity acceptance against a replayed database:
# sealed grants + table JSON section; parties 1–4 auto-assign to one adjacent
# group inside a section; explicit create and assign/move refuse cross-section,
# non-adjacent, under-capacity, duplicate, unknown and unavailable seats; the
# 15-minute turnaround on both sides with same-day reuse (16:00–18:00 then 18:15);
# a move to another location records it; viewers cannot create or move.
# tests/sql/s110_booking_seat_integrity.sql seeds fixtures in one transaction and
# rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s110_booking_seat_integrity.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then
  echo "s110_booking_seat_integrity: passed"
else
  echo "s110_booking_seat_integrity: FAILED" >&2
  exit 1
fi
