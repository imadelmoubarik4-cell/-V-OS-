import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "supabase" / "production-adoption"
MANIFEST = json.loads((PACKAGE / "manifest.json").read_text(encoding="utf-8"))
CANDIDATE = (PACKAGE / "sql" / "020_phase1_candidate.psql").read_text(encoding="utf-8")
FLATTENED_PATH = ROOT / MANIFEST["flattened_migration"]
FLATTENED = FLATTENED_PATH.read_text(encoding="utf-8")
HARDENING = (PACKAGE / "sql" / "010_rls_auto_enable_hardening.sql").read_text(encoding="utf-8").lower()
RUNNER = (ROOT / "scripts" / "verify_production_adoption_dry_run.sh").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "production-adoption-dry-run.yml").read_text(encoding="utf-8")


class ProductionAdoptionContractTests(unittest.TestCase):
    def test_git_only_flattened_migration_metadata(self):
        self.assertFalse((ROOT / "supabase" / "migrations" / "20260909_production_adoption.sql").exists())
        self.assertTrue(FLATTENED_PATH.exists())
        self.assertEqual(
            MANIFEST["refreshed_against_base_commit"],
            "8411b54b8a71bb94149517d22261632fe4aee020",
        )
        self.assertEqual(MANIFEST["refreshed_after_pull_request"], 29)
        self.assertFalse(MANIFEST["candidate_sql_changed_by_refresh"])
        self.assertFalse(MANIFEST["hosted_staging_branch_created"])
        self.assertFalse(MANIFEST["hosted_database_modified"])
        self.assertFalse(MANIFEST["production_apply_authorized"])
        self.assertFalse(MANIFEST["edge_function_deploy_authorized"])
        self.assertFalse(MANIFEST["frontend_endpoint_switch_authorized"])
        self.assertEqual(MANIFEST["flattened_candidate_prepared_in_pull_request"], 30)
        self.assertEqual(
            MANIFEST["flattened_against_base_commit"],
            "67ba67080f7f92bfe1e6324c3c971c490bfdc6cc",
        )
        self.assertTrue(MANIFEST["flattened_migration_created_in_git_only"])
        self.assertFalse(MANIFEST["flattened_sql_applied"])
        self.assertFalse(MANIFEST["production_fingerprint_values_stored_in_repository"])
        self.assertTrue(MANIFEST["production_fingerprint_refresh_required_before_apply"])

    def test_candidate_uses_exact_reviewed_allowlist(self):
        includes = [
            line.removeprefix("\\ir ").strip()
            for line in CANDIDATE.splitlines()
            if line.startswith("\\ir ")
        ]
        self.assertEqual(includes, [
            "../../migrations/20260802090000_phase_a_02_inventory_staging.sql",
            "../../migrations/20260806104705_atlas_phase1_profiles_security_gate.sql",
            "../../migrations/20260806105543_atlas_phase1_recipe_catalog_gate.sql",
            "../../migrations/20260806151244_atlas_phase1_recipe_catalog_runtime_fix.sql",
            "../../migrations/20260806171317_atlas_phase1_public_menu_and_adjustment_lint_fix.sql",
        ])

    def test_dangerous_or_isolated_files_are_excluded(self):
        lower_candidate = CANDIDATE.lower()
        lower_flattened = FLATTENED.lower()
        for excluded in MANIFEST["excluded_patterns"]:
            self.assertNotIn(excluded, lower_candidate)
            self.assertNotIn(excluded, lower_flattened)

    def test_flattened_migration_exactly_matches_deployable_sources(self):
        preamble = """-- PR30 flattened Phase 1 production-adoption candidate.
--
-- Git-only artifact generated from the reviewed PR28 allowlist. This file has
-- not been applied to staging or production. Applying it requires separate
-- approval after production-shaped staging validation.
--
-- Deliberately excluded: preflight/verification assertions, legacy baseline,
-- branch-only and transfer migrations, destructive consolidation, PR27 Reports
-- closure, atlas_private runtime modules, Edge Functions and endpoint changes.

"""
        sections = []
        for relative in MANIFEST["flattened_source_files"]:
            source = (ROOT / relative).read_text(encoding="utf-8").rstrip()
            sections.append(
                f"-- BEGIN FLATTENED SOURCE: {relative}\n"
                f"{source}\n"
                f"-- END FLATTENED SOURCE: {relative}"
            )
        self.assertEqual(FLATTENED, preamble + "\n\n".join(sections) + "\n")
        self.assertIsNone(re.search(r"^\\\\", FLATTENED, re.MULTILINE))

    def test_allowlisted_sql_has_no_destructive_or_realtime_schema_statements(self):
        include_paths = [
            (PACKAGE / "sql" / relative).resolve()
            for relative in (
                line.removeprefix("\\ir ").strip()
                for line in CANDIDATE.splitlines()
                if line.startswith("\\ir ")
            )
        ]
        for path in include_paths:
            sql = path.read_text(encoding="utf-8")
            self.assertIsNone(
                re.search(r"^\s*(drop\s+(table|schema)|truncate\s+)", sql, re.IGNORECASE | re.MULTILINE),
                path,
            )
            self.assertNotIn("realtime.", sql.lower(), path)

    def test_security_definer_execution_is_revoked_from_browser_roles(self):
        self.assertIn("revoke execute on function public.rls_auto_enable()", HARDENING)
        self.assertIn("from public, anon, authenticated", HARDENING)
        self.assertNotIn("grant execute", HARDENING)

    def test_runner_refuses_remote_database_hosts(self):
        self.assertIn("127.0.0.1|localhost|::1", RUNNER)
        self.assertIn("Refusing production-adoption dry run against non-loopback PGHOST", RUNNER)
        self.assertIn(MANIFEST["flattened_migration"], RUNNER)
        self.assertNotIn("020_phase1_candidate.psql", RUNNER)

    def test_workflow_has_no_hosted_database_credentials(self):
        lower_workflow = WORKFLOW.lower()
        self.assertIn("postgres:17", lower_workflow)
        self.assertIn("verify_production_adoption_dry_run.sh", lower_workflow)
        self.assertIn("docs/production_adoption_pr28.md", lower_workflow)
        self.assertNotIn("supabase_access_token", lower_workflow)
        self.assertNotIn("database_url", lower_workflow)
        self.assertNotIn("dnefgcmjcgxlynycxkts", lower_workflow)


if __name__ == "__main__":
    unittest.main()
