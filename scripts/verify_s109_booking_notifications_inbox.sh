#!/usr/bin/env bash
# Runs the S109 in-app booking notification inbox acceptance against a replayed
# database: a public request writes a real manager/admin inbox (not
# bartender/viewer) with an unread count and a bookings deep-link; the lifecycle
# workflow is gated on the public_token origin marker so legacy (null token)
# bookings trigger nothing; rejection ('declined') is distinguished from
# cancellation and no_show never emails the guest; the status/request RPCs enforce
# the DB feature flag; a conflicting idempotency reuse is refused; the email outbox
# de-duplicates repeated identical events. The SQL seeds fixtures in one
# transaction and rolls back. Loopback databases only.
set -euo pipefail
: "${PGHOST:=127.0.0.1}"; : "${PGUSER:=postgres}"; : "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s109_booking_notifications_inbox.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then echo "s109_booking_notifications_inbox: passed"; else echo "s109_booking_notifications_inbox: FAILED" >&2; exit 1; fi
