#!/usr/bin/env bash
# Runs the S113 guest booking email acceptance against a replayed database: sealed
# functions and service-role worker RPCs; the owner switch guest_email_enabled defaults
# off (guest emails stay queued, nothing is promised, a test email to the sender still
# goes); the site language is stored; switching on discards earlier emails; claimed
# emails are rendered in the guest's language with date, time, guests and stools;
# sent once, retry with back-off then failed, never sent late, to a bad address or
# twice after an interrupted send; a declined request gets the declined text; the tick
# and secret lookup are quiet without pg_net / Vault.
# tests/sql/s113_booking_guest_email.sql seeds fixtures in one transaction and rolls
# back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s113_booking_guest_email.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then
  echo "s113_booking_guest_email: passed"
else
  echo "s113_booking_guest_email: FAILED" >&2
  exit 1
fi
