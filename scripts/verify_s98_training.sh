#!/usr/bin/env bash
# Runs the S98 Training database/authorization acceptance against a replayed database:
# the private atlas-training-videos bucket has no storage.objects policy, the training
# tables and RPCs are sealed from browser roles, a bartender cannot author, a manager's
# create/attach/publish flow works, publishing v2 preserves v1's media and completion,
# completion is version-specific and idempotent, and role forgery / inactive profiles
# fail closed. tests/sql/s98_training.sql seeds fixtures in one transaction and rolls
# back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(psql -X -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/s98_training.sql" 2>&1)"
echo "$output"
if grep -q 'all authorization and integrity checks passed' <<<"$output"; then
  echo "s98_training: passed"
else
  echo "s98_training: FAILED" >&2
  exit 1
fi
