#!/usr/bin/env bash
# Runs the S87 preview-only acceptance scripts against a replayed database.
# Each script seeds fixtures inside one transaction, prints a JSON verdict and
# rolls back. Loopback databases only.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
status=0
for script in \
  verify_s87_recipe_delete_guard_preview.sql \
  verify_s87_atlas_media_policies_preview.sql \
  verify_s87_knowledge_role_matrix_preview.sql; do
  result="$(psql -v ON_ERROR_STOP=1 -At -f "$ROOT/scripts/$script" | grep '^{' | tail -1)"
  echo "$script: $result"
  if ! grep -q '": "passed"' <<<"$result"; then status=1; fi
done
exit "$status"
