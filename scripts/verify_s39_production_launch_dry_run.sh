#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_s39_launch}"
export PGHOST PGPORT PGUSER PGDATABASE

case "$PGHOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "Refusing S39 production-launch dry run against non-loopback PGHOST: $PGHOST" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RUNNER_TEMP:-/tmp}/vaos-s39-production-launch"
mkdir -p "$WORK_DIR"

# This establishes the production-shaped six-migration baseline, applies the
# pinned Phase 1 adoption file, and proves its protected fingerprint and roles.
bash "$ROOT/scripts/verify_production_adoption_dry_run.sh"

record_migration() {
  local migration_name="$1"
  local version="${migration_name%%_*}"
  local name="${migration_name#*_}"
  name="${name%.sql}"
  psql -v ON_ERROR_STOP=1 -X -q -c \
    "insert into supabase_migrations.schema_migrations(version,name,statements) values ('$version','$name',array[]::text[]) on conflict (version) do nothing"
}

record_migration "20260910094217_atlas_phase1_production_adoption.sql"

psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/supabase/production-launch/000_read_only_snapshot.sql" \
  > "$WORK_DIR/before.jsonl"

remaining_migrations=(
  "supabase/migrations/20260910104621_atlas_phase1_recipe_access_and_index_cleanup.sql"
  "supabase/migrations/20260910121248_atlas_purchase_order_lifecycle.sql"
  "supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql"
  "supabase/s33/migrations/20260910211903_atlas_s33_runtime_source_contracts.sql"
  "supabase/s33/migrations/20260910201435_atlas_s33_csv_import_pipeline.sql"
  "supabase/migrations/20260911124006_s34_foreign_key_indexes.sql"
  "supabase/migrations/20260911124039_s34_notification_and_conversation_stars.sql"
  "supabase/migrations/20260911160616_s36_report_events_rls.sql"
)

for relative in "${remaining_migrations[@]}"; do
  migration_path="$ROOT/$relative"
  psql -v ON_ERROR_STOP=1 -X -q -1 -f "$migration_path"
  record_migration "$(basename "$migration_path")"
done

psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/supabase/production-launch/000_read_only_snapshot.sql" \
  > "$WORK_DIR/after.jsonl"

python "$ROOT/scripts/verify_s39_production_snapshots.py" \
  "$WORK_DIR/before.jsonl" "$WORK_DIR/after.jsonl"

psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/scripts/verify_phase1_role_matrix_preview.sql" \
  > "$WORK_DIR/role-matrix.jsonl"
psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/scripts/verify_phase1_security_gate.sql" \
  > "$WORK_DIR/security-gate.jsonl"

python - "$WORK_DIR" <<'PY'
import json
from pathlib import Path
import sys

work = Path(sys.argv[1])


def last_json(path):
    values = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if raw.startswith("{") and raw.endswith("}"):
            try:
                values.append(json.loads(raw))
            except json.JSONDecodeError:
                pass
    if not values:
        raise AssertionError(f"No JSON result found in {path}")
    return values[-1]


role = last_json(work / "role-matrix.jsonl")
security = last_json(work / "security-gate.jsonl")
assert role.get("passed") is True and role.get("failed_count") == 0, role
assert security.get("tables_without_rls") == [], security
assert security.get("unsafe_non_public_views") == [], security
assert security.get("browser_function_exposure") == [], security
assert security.get("security_lint_blockers") == [], security
print(json.dumps({
    "s39_production_launch_dry_run": "passed",
    "migration_count": 9,
    "protected_fingerprint_unchanged": True,
    "role_and_security_gates": "passed",
}))
PY
