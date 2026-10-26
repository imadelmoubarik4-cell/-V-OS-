#!/usr/bin/env bash
# Runs the S112 direct website booking acceptance against a replayed database:
# sealed helpers; the owner numbering (same stool ids and floor positions, owner
# numbers and sections L/T1/T2/R); the owner switch public_instant_confirm defaults
# off and drives booking_mode; seat_map keys equal the slots and list only free online
# stools; with the switch off a direct booking stays requested, with it on a direct
# booking is confirmed on the chosen (or an auto-found adjacent) run; a taken stool is
# atlas:seat_taken; corners, the 10|11 gap, gaps, wrong counts, duplicates, unknown and
# staff-only stools are refused; requests hold the chosen stools; idempotent replay;
# confirmed website bookings alert managers. tests/sql/s112_public_direct_booking.sql
# seeds fixtures in one transaction and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s112_public_direct_booking.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then
  echo "s112_public_direct_booking: passed"
else
  echo "s112_public_direct_booking: FAILED" >&2
  exit 1
fi