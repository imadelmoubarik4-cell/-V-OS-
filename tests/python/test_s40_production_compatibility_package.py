import hashlib
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads(
    (ROOT / "docs/release/Atlas_S40_Production_Compatibility_Manifest.json").read_text(encoding="utf-8")
)
MIGRATION = (
    ROOT / "supabase/s40/migrations/20260914204202_s40_production_source_contract_adoption.sql"
).read_text(encoding="utf-8")
FIXTURE = (ROOT / "supabase/s40/sql/005_existing_production_source_contracts_fixture.sql").read_text(
    encoding="utf-8"
)
DRY_RUN = (ROOT / "scripts/verify_s40_production_compatibility_dry_run.sh").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/s40-production-compatibility.yml").read_text(encoding="utf-8")
PACKAGE_DOC = (ROOT / "docs/release/Atlas_S40_Production_Compatibility_Package.md").read_text(
    encoding="utf-8"
)


class S40ProductionCompatibilityPackageTests(unittest.TestCase):
    def test_package_is_strictly_git_only(self):
        self.assertEqual(MANIFEST["status"], "Git-only; no hosted execution authorized")
        self.assertTrue(all(value is False for value in MANIFEST["boundaries"].values()))
        self.assertFalse(MANIFEST["production_checkpoint"]["real_stock_values_stored_in_public_git"])

    def test_failed_s39_file_is_unchanged_and_superseded(self):
        replaced = MANIFEST["replaced_s39_step"]
        self.assertEqual(replaced["version"], "20260910211903")
        self.assertIn("fully rolled back", replaced["production_status"])
        self.assertEqual(hashlib.sha256((ROOT / replaced["path"]).read_bytes()).hexdigest(), replaced["sha256"])
        self.assertNotIn(replaced["version"], {
            item["version"] for item in MANIFEST["remaining_migration_plan"]
        })

    def test_revised_remaining_plan_is_exact_and_pinned(self):
        plan = MANIFEST["remaining_migration_plan"]
        self.assertEqual([item["order"] for item in plan], list(range(1, 6)))
        self.assertEqual(len({item["version"] for item in plan}), 5)
        self.assertEqual(plan[0]["version"], "20260914204202")
        for item in plan:
            path = ROOT / item["path"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"])
            self.assertNotIn("realtime.", path.read_text(encoding="utf-8").lower())

    def test_compatibility_migration_adopts_public_tables_without_row_or_column_changes(self):
        lowered = MIGRATION.lower()
        for relation in ("public.onboarding_tasks", "public.onboarding_progress", "public.shifts"):
            self.assertIn(relation, lowered)
        self.assertNotRegex(lowered, r"\b(insert|update|delete|truncate)\s+(into\s+|from\s+)?public\.(onboarding_tasks|onboarding_progress|shifts)\b")
        self.assertNotRegex(lowered, r"\b(drop|alter)\s+table\s+public\.(onboarding_tasks|onboarding_progress|shifts)\b")
        public_creates = re.findall(
            r"create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_]+)", lowered
        )
        self.assertEqual(public_creates, [])
        self.assertIn("create table if not exists atlas_private.report_events", lowered)
        self.assertIn("alter table atlas_private.report_events enable row level security", lowered)
        self.assertIn("service role reads report events", lowered)
        self.assertIn("service role inserts report events", lowered)

    def test_preflight_is_fail_closed_on_contracts_and_security(self):
        for phrase in (
            "source-contract mismatch",
            "requires a primary key",
            "onboarding_progress(task_id,user_id) uniqueness",
            "requires rls",
            "incomplete authenticated grants",
            "requires policy",
        ):
            self.assertIn(phrase, MIGRATION.lower())
        self.assertIn("lock_timeout", MIGRATION)
        self.assertIn("statement_timeout", MIGRATION)

    def test_fixture_is_synthetic_and_mirrors_only_observed_row_count(self):
        self.assertIn("Synthetic schema-only/current-shape fixture", FIXTURE)
        self.assertEqual(FIXTURE.count("'Synthetic task "), 8)
        self.assertNotIn("inventory_items", FIXTURE)
        self.assertNotIn("inventory_movements", FIXTURE)

    def test_disposable_replay_reproduces_failure_then_proves_preservation_and_retry(self):
        self.assertIn("127.0.0.1|localhost|::1", DRY_RUN)
        self.assertIn("Expected the current ten-migration production checkpoint", DRY_RUN)
        self.assertIn("S33 runtime source contract target is not empty", DRY_RUN)
        self.assertEqual(DRY_RUN.count('psql -v ON_ERROR_STOP=1 -X -q -1 -f "$compatibility"'), 2)
        self.assertIn("verify_s40_production_compatibility_snapshots.py", DRY_RUN)
        self.assertIn("verify_phase1_role_matrix_preview.sql", DRY_RUN)
        self.assertIn("verify_phase1_security_gate.sql", DRY_RUN)
        self.assertNotIn("supabase db push", DRY_RUN)
        self.assertNotIn("supabase functions deploy", DRY_RUN)

    def test_ci_has_no_hosted_credentials_or_mutation_commands(self):
        lowered = WORKFLOW.lower()
        self.assertIn("postgres:17", lowered)
        self.assertIn("verify_s40_production_compatibility_dry_run.sh", lowered)
        self.assertNotIn("supabase_access_token", lowered)
        self.assertNotIn("database_url", lowered)
        self.assertNotIn("supabase db push", lowered)
        self.assertNotIn("supabase functions deploy", lowered)

    def test_endpoint_sources_are_pinned_unchanged(self):
        for relative, expected in MANIFEST["unchanged_endpoint_files"].items():
            self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected)

    def test_docs_preserve_separate_production_approval(self):
        for phrase in (
            "Git-only replacement plan",
            "does not authorize",
            "Explicit stop boundary",
            "new explicit approval",
        ):
            self.assertIn(phrase, PACKAGE_DOC)


if __name__ == "__main__":
    unittest.main()
