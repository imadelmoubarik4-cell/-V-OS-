#!/usr/bin/env bash
# Runs the S107 public-booking API acceptance against a replayed database: the
# public RPCs are sealed from browser roles; both server gates default OFF; with
# the server flag on, availability honours the online party cap, the 90-day
# horizon, opening hours + the close-derived last start and section-bounded
# contiguity; a request is always 'requested' with an unguessable token and an
# expiring hold and no permanent seat; only the Bar is online-bookable; status
# needs the token and leaks no private fields; idempotency and the rate limit
# hold; a second request cannot double-hold the same stools. The SQL seeds
# fixtures in one transaction and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s107_public_booking.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then
  echo "s107_public_booking: passed"
else
  echo "s107_public_booking: FAILED" >&2
  exit 1
fi
