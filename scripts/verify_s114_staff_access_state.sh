#!/usr/bin/env bash
# Runs the S114 staff access state acceptance against a replayed database
# (scripts/verify_full_migration_replay.sh builds vaos_replay): the access-state
# functions are service_role-only; a fresh invitation is audited and never
# active; removed, demoted and directly-changed profiles stay ever_active; Team
# removals, pending role changes, the inviter's current status and the
# invitation's age are read correctly; a pre-audit profile reads as not
# audited; the answer is exactly seven non-personal keys.
# tests/sql/s114_staff_access_state.sql seeds fixtures in one transaction and
# rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s114_staff_access_state.sql" 2>&1)"
echo "$output"
if grep -q 'S114 all staff access state checks passed' <<<"$output"; then
  echo "s114_staff_access_state: passed"
else
  echo "s114_staff_access_state: FAILED" >&2
  exit 1
fi
