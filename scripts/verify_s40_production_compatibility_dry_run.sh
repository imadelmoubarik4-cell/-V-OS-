#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_s40_compatibility}"
export PGHOST PGPORT PGUSER PGDATABASE

case "$PGHOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "Refusing S40 compatibility replay against non-loopback PGHOST: $PGHOST" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RUNNER_TEMP:-/tmp}/vaos-s40-production-compatibility"
mkdir -p "$WORK_DIR"

record_migration() {
  local migration_name="$1"
  local version="${migration_name%%_*}"
  local name="${migration_name#*_}"
  name="${name%.sql}"
  psql -v ON_ERROR_STOP=1 -X -q -c \
    "insert into supabase_migrations.schema_migrations(version,name,statements) values ('$version','$name',array[]::text[]) on conflict (version) do nothing"
}

ATLAS_BOOTSTRAP_ONLY=1 bash "$ROOT/scripts/verify_full_migration_replay.sh"

psql -v ON_ERROR_STOP=1 -X -q \
  -f "$ROOT/supabase/migrations/20260801000000_legacy_schema_baseline.sql"

baseline_migrations=(
  20260801105516_atlas_alpha_02_recipe_engine.sql
  20260801125810_atlas_alpha_02_phase1_recipe_architecture.sql
  20260801165947_atlas_vision_media_and_import_foundation.sql
  20260801180202_atlas_inventory_import_audit_fields.sql
  20260801222046_inventory_imported_at_default.sql
  20260801224004_phase_a_01_import_queue.sql
)

for migration_name in "${baseline_migrations[@]}"; do
  migration_path="$ROOT/supabase/migrations/$migration_name"
  psql -v ON_ERROR_STOP=1 -X -q -1 -f "$migration_path"
  record_migration "$migration_name"
done

psql -v ON_ERROR_STOP=1 -X -q -1 \
  -f "$ROOT/supabase/s40/sql/005_existing_production_source_contracts_fixture.sql"
psql -v ON_ERROR_STOP=1 -X -q -1 \
  -f "$ROOT/supabase/production-adoption/sql/005_local_rls_trigger_fixture.sql"

psql -v ON_ERROR_STOP=1 -X -qAt -1 \
  -f "$ROOT/supabase/production-adoption/sql/000_preflight.sql" \
  -f "$ROOT/supabase/migrations/20260910094217_atlas_phase1_production_adoption.sql" \
  -f "$ROOT/supabase/production-adoption/sql/090_verify.sql" \
  > "$WORK_DIR/adoption.jsonl"
record_migration "20260910094217_atlas_phase1_production_adoption.sql"

applied_s39_migrations=(
  "supabase/migrations/20260910104621_atlas_phase1_recipe_access_and_index_cleanup.sql"
  "supabase/migrations/20260910121248_atlas_purchase_order_lifecycle.sql"
  "supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql"
)

for relative in "${applied_s39_migrations[@]}"; do
  migration_path="$ROOT/$relative"
  psql -v ON_ERROR_STOP=1 -X -q -1 -f "$migration_path"
  record_migration "$(basename "$migration_path")"
done

checkpoint_count="$(psql -v ON_ERROR_STOP=1 -X -qAt -c \
  "select count(*) from supabase_migrations.schema_migrations")"
if [[ "$checkpoint_count" != "10" ]]; then
  echo "Expected the current ten-migration production checkpoint, found $checkpoint_count" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/supabase/production-launch/000_read_only_snapshot.sql" \
  > "$WORK_DIR/protected-before.jsonl"
psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/supabase/s40/sql/090_source_contract_snapshot.sql" \
  > "$WORK_DIR/source-before.jsonl"

failed_s39="$ROOT/supabase/s33/migrations/20260910211903_atlas_s33_runtime_source_contracts.sql"
if psql -v ON_ERROR_STOP=1 -X -q -1 -f "$failed_s39" \
  > "$WORK_DIR/expected-s39-failure.log" 2>&1; then
  echo "The superseded S39 source-contract migration unexpectedly succeeded" >&2
  exit 1
fi
if ! grep -q "S33 runtime source contract target is not empty" "$WORK_DIR/expected-s39-failure.log"; then
  echo "The superseded S39 migration did not reproduce the reviewed production failure" >&2
  exit 1
fi

failed_state="$(psql -v ON_ERROR_STOP=1 -X -qAt -c \
  "select (to_regclass('atlas_private.report_events') is null)::text || '|' || count(*)::text from supabase_migrations.schema_migrations where version='20260910211903'")"
if [[ "$failed_state" != "true|0" ]]; then
  echo "The expected S39 failure did not roll back cleanly: $failed_state" >&2
  exit 1
fi

compatibility="$ROOT/supabase/s40/migrations/20260914204202_s40_production_source_contract_adoption.sql"
psql -v ON_ERROR_STOP=1 -X -q -1 -f "$compatibility"
psql -v ON_ERROR_STOP=1 -X -q -1 -f "$compatibility"
record_migration "$(basename "$compatibility")"

remaining_migrations=(
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
  > "$WORK_DIR/protected-after.jsonl"
psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/supabase/s40/sql/090_source_contract_snapshot.sql" \
  > "$WORK_DIR/source-after.jsonl"

python "$ROOT/scripts/verify_s40_production_compatibility_snapshots.py" \
  "$WORK_DIR/protected-before.jsonl" \
  "$WORK_DIR/protected-after.jsonl" \
  "$WORK_DIR/source-before.jsonl" \
  "$WORK_DIR/source-after.jsonl"

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
    "s40_production_compatibility_replay": "passed",
    "current_checkpoint_migrations": 10,
    "revised_remaining_migrations": 5,
    "old_s39_failure_reproduced_and_rolled_back": True,
    "compatibility_retry": "passed",
    "protected_and_source_fingerprints": "unchanged",
    "role_and_security_gates": "passed",
}))
PY
