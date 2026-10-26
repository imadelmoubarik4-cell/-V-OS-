#!/usr/bin/env bash
# Runs the S108 booking-notifications acceptance against a replayed database: the
# email outbox is sealed; a public request alerts managers/admins (not
# bartender/viewer) and queues the guest email; the reference is KANEL-prefixed;
# approval/change/cancellation queue the matching emails; nothing ever leaves the
# queue (outbound delivery is inert); a missing guest email still alerts staff;
# idempotency keys are isolated across fingerprints. The SQL seeds fixtures in one
# transaction and rolls back. Loopback databases only.
set -euo pipefail
: "${PGHOST:=127.0.0.1}"; : "${PGUSER:=postgres}"; : "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s108_booking_notifications.sql" 2>&1)"
echo "$output"
if grep -q 'all checks passed' <<<"$output"; then echo "s108_booking_notifications: passed"; else echo "s108_booking_notifications: FAILED" >&2; exit 1; fi
