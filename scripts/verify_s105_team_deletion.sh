#!/usr/bin/env bash
# Runs the S105 team-member deletion database/authorization acceptance against a
# replayed database (scripts/verify_full_migration_replay.sh builds vaos_replay):
# the deletion audit + RPCs are sealed from browser roles (service_role only; anon
# denied at runtime); the audit is append-only even for service_role; a member
# with worked shifts is anonymized while the shift survives (ON DELETE RESTRICT)
# and a member with none is hard-deleted with availability/time-off/responses
# cascading; the schedule-only route refuses a login-linked row; exactly one
# identifier is required and an unknown target raises instead of a false success;
# the permanent-deletion audit stores no identifying name; remove-from-team
# archives reversibly. tests/sql/s105_team_member_deletion.sql seeds fixtures in
# one transaction and rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s105_team_member_deletion.sql" 2>&1)"
echo "$output"
if grep -q 'all deletion authorization and integrity checks passed' <<<"$output"; then
  echo "s105_team_member_deletion: passed"
else
  echo "s105_team_member_deletion: FAILED" >&2
  exit 1
fi
