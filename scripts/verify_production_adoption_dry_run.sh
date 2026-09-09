#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_adoption}"
export PGHOST PGPORT PGUSER PGDATABASE

case "$PGHOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "Refusing production-adoption dry run against non-loopback PGHOST: $PGHOST" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RUNNER_TEMP:-/tmp}/vaos-production-adoption"
mkdir -p "$WORK_DIR"

ATLAS_BOOTSTRAP_ONLY=1 bash "$ROOT/scripts/verify_full_migration_replay.sh"

# Reconstruct the schema-only production shape. The legacy baseline is a fixture,
# not a production ledger entry. The six hosted migration versions are then
# applied and recorded exactly as production currently reports them.
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
  psql -v ON_ERROR_STOP=1 -X -q -f "$migration_path"
  version="${migration_name%%_*}"
  name="${migration_name#*_}"
  name="${name%.sql}"
  psql -v ON_ERROR_STOP=1 -X -q -c \
    "insert into supabase_migrations.schema_migrations(version,name,statements) values ('$version','$name',array[]::text[]) on conflict (version) do nothing"
done

psql -v ON_ERROR_STOP=1 -X -q \
  -f "$ROOT/supabase/production-adoption/sql/005_local_rls_trigger_fixture.sql"

psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/supabase/production-adoption/sql/000_preflight.sql" \
  -f "$ROOT/supabase/production-adoption/sql/010_rls_auto_enable_hardening.sql" \
  -f "$ROOT/supabase/production-adoption/sql/020_phase1_candidate.psql" \
  -f "$ROOT/supabase/production-adoption/sql/090_verify.sql" \
  | tee "$WORK_DIR/adoption.jsonl"

psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/scripts/verify_phase1_role_matrix_preview.sql" \
  > "$WORK_DIR/role-matrix.jsonl"
psql -v ON_ERROR_STOP=1 -X -qAt \
  -f "$ROOT/scripts/verify_phase1_security_gate.sql" \
  > "$WORK_DIR/security-gate.jsonl"

python - "$WORK_DIR" <<'PY'
import json
import pathlib
import sys

work = pathlib.Path(sys.argv[1])


def json_objects(path: pathlib.Path) -> list[dict]:
    values = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if raw.startswith("{") and raw.endswith("}"):
            try:
                values.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    if not values:
        raise AssertionError(f"No JSON result found in {path}")
    return values


adoption = json_objects(work / "adoption.jsonl")[-1]
role = json_objects(work / "role-matrix.jsonl")[-1]
security = json_objects(work / "security-gate.jsonl")[-1]

assert adoption["phase"] == "verified", adoption
assert adoption["protected_fingerprint_unchanged"] is True, adoption
assert adoption["rls_auto_enable_browser_execute"] is False, adoption
assert adoption["ensure_rls_enabled"] is True, adoption
assert adoption["public_tables_without_rls"] == [], adoption
assert adoption["atlas_private_created"] is False, adoption

assert role.get("passed") is True, role
assert role.get("failed_count") == 0, role
assert role.get("passed_count", 0) >= 20, role

assert security.get("tables_without_rls") == [], security
assert security.get("unsafe_non_public_views") == [], security
assert security.get("browser_function_exposure") == [], security
assert security.get("security_lint_blockers") == [], security

print(json.dumps({
    "production_adoption_dry_run": "passed",
    "protected_fingerprint_unchanged": True,
    "role_matrix_passed": role["passed_count"],
    "security_gate": "passed",
}))
PY
