#!/usr/bin/env bash
# Runs the S96 database/RLS acceptance against a replayed database: ownership and
# self-escalation checks for every browser-writable public table, the 12 browser RPCs
# for every non-manager identity, the purchase receipt price guard and the read-only
# stock ledger; then the concurrency checks in verify_s96_races.sh. The SQL script seeds fixtures inside one transaction, prints a JSON verdict
# and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
status=0
for script in verify_s96_rls_ownership.sql; do
  result="$(psql -X -v ON_ERROR_STOP=1 -At -f "$ROOT/scripts/$script" | grep '^{"tests' | tail -1)"
  echo "$script: $result"
  if ! grep -q '"s96_rls_ownership": "passed"' <<<"$result"; then status=1; fi
done
# Concurrency (committed fixtures, cleaned up afterwards): last-admin race, concurrent
# approvals, concurrent waste, duplicate request ids.
if ! bash "$ROOT/scripts/verify_s96_races.sh"; then status=1; fi
exit "$status"
