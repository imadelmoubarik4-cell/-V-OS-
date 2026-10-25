#!/usr/bin/env bash
# Runs the S111 booking personal-data retention acceptance against a replayed
# database: sealed purge + run log; 30-day minimum window; dry run changes nothing;
# bookings whose visit ended more than 90 days ago are anonymised (all guest fields,
# token, idempotency key, provider ref) while date/party/status/reference stay;
# bookings inside the window and future bookings untouched; linked inbox, email
# outbox and booking push rows deleted; no notifications or emails fired; repeat
# run is a no-op; every run logged with counts only.
# tests/sql/s111_booking_personal_data_retention.sql seeds fixtures in one
# transaction and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s111_booking_personal_data_retention.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then
  echo "s111_booking_personal_data_retention: passed"
else
  echo "s111_booking_personal_data_retention: FAILED" >&2
  exit 1
fi
