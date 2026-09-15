import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "docs/release/Atlas_S39_Production_Launch_Manifest.json"
MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
S41_ADDENDUM = json.loads(
    (ROOT / "docs/release/Atlas_S41_Production_Function_Addendum.json").read_text(encoding="utf-8")
)
PACKAGE_DOC = (ROOT / "docs/release/Atlas_S39_Production_Launch_Package.md").read_text(encoding="utf-8")
SNAPSHOT_SQL = (ROOT / "supabase/production-launch/000_read_only_snapshot.sql").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/s39-production-launch-package.yml").read_text(encoding="utf-8")
DRY_RUN = (ROOT / "scripts/verify_s39_production_launch_dry_run.sh").read_text(encoding="utf-8")


def load_builder():
    path = ROOT / "scripts/build_s39_production_runtime.py"
    spec = importlib.util.spec_from_file_location("build_s39_production_runtime", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class S39ProductionLaunchPackageTests(unittest.TestCase):
    def test_boundaries_are_git_only(self):
        self.assertEqual(MANIFEST["status"], "Git-only; no hosted execution authorized")
        self.assertTrue(all(value is False for value in MANIFEST["boundaries"].values()))
        self.assertFalse(MANIFEST["runtime"]["deployment_authorized"])
        self.assertFalse(MANIFEST["observed_production_baseline"]["real_stock_values_stored_in_public_git"])

    def test_source_runtime_and_frontend_are_pinned(self):
        source_manifest = ROOT / MANIFEST["runtime"]["source_manifest"]
        self.assertEqual(
            hashlib.sha256(source_manifest.read_bytes()).hexdigest(),
            MANIFEST["runtime"]["source_manifest_sha256"],
        )
        for relative, expected in MANIFEST["unchanged_source_files"].items():
            self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected)

    def test_migration_plan_is_exact_and_non_destructive(self):
        self.assertEqual([item["order"] for item in MANIFEST["migration_plan"]], list(range(1, 10)))
        self.assertEqual(len({item["version"] for item in MANIFEST["migration_plan"]}), 9)
        for item in MANIFEST["migration_plan"]:
            path = ROOT / item["path"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"])
            sql = path.read_text(encoding="utf-8").lower()
            self.assertNotIn("realtime.", sql, path)
            self.assertIsNone(re.search(r"^\s*(truncate|drop\s+(table|schema))\b", sql, re.MULTILINE), path)

    def test_stock_snapshot_is_select_only_and_complete(self):
        lowered = re.sub(r"--.*", "", SNAPSHOT_SQL.lower())
        self.assertTrue(lowered.lstrip().startswith("with "))
        self.assertIsNone(re.search(r"\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b", lowered))
        for token in (
            "inventory_items", "inventory_movements", "suppliers", "recipes",
            "profiles", "auth.users", "negative_quantity_count", "fingerprint",
        ):
            self.assertIn(token, lowered)

    def test_runtime_builder_is_fail_closed_and_undeployed(self):
        builder = load_builder()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "runtime"
            result = builder.build(output, "https://os-vabar.netlify.app")
            self.assertEqual(result["functions"], 19)
            runtime = json.loads((output / "runtime-manifest.json").read_text(encoding="utf-8"))
            self.assertFalse(runtime["deployment_authorized"])
            self.assertFalse(runtime["endpoint_cutover_authorized"])
            self.assertFalse(runtime["real_stock_writes_authorized"])
            self.assertEqual(runtime["safe_initial_variables"], {
                "ATLAS_IMPORT_ENABLED": "false",
                "ATLAS_STOCK_COUNT_PUBLICATION_ENABLED": "false",
                "ATLAS_PUSH_DELIVERY_ENABLED": "false",
            })
            self.assertEqual(len(runtime["functions"]), 19)
            self.assertEqual(sum(item["verify_jwt"] for item in runtime["functions"]), 1)
            self.assertIn("atlas-item-master", {item["name"] for item in runtime["functions"]})
            combined = "\n".join(path.read_text(encoding="utf-8") for path in output.rglob("*.ts"))
            self.assertIn(MANIFEST["production_target"]["origin"], combined)
            self.assertNotIn("atialqebqxcquzdkezln", combined)
            self.assertNotIn("uhbamqetppqmygesoeeh", combined)
            self.assertNotIn("atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site", combined)
            self.assertNotRegex(combined, r"access-control-allow-origin[\"']?\s*:\s*[\"']\*")
            self.assertIn("all write flags disabled", combined)
            self.assertIn("SUPABASE_PUBLISHABLE_KEYS", combined)
            self.assertIn("atlasAuthProjectUrl()", combined)
            self.assertIn("atlasAuthPublishableKey()", combined)
            self.assertNotIn('Deno.env.get("ATLAS_IMPORT_ENABLED") !== "false"', combined)
            javascript = "\n".join(path.read_text(encoding="utf-8") for path in output.rglob("*.mjs"))
            self.assertNotIn("): string", javascript)
            import_entrypoint = (output / "functions/atlas-import-worker/index.ts").read_text(encoding="utf-8")
            self.assertIn("Import is disabled.", import_entrypoint)
            item_master = (output / "functions/atlas-item-master/index.ts").read_text(encoding="utf-8")
            self.assertNotRegex(item_master, r'access-control-allow-origin["\']?\s*:\s*["\']\*')
            self.assertIn("atlasAuthProjectUrl()", item_master)

    def test_s41_addendum_is_exact_and_fail_closed(self):
        self.assertEqual(S41_ADDENDUM["production_target"], MANIFEST["production_target"]["project_ref"])
        self.assertEqual(len(S41_ADDENDUM["functions"]), 1)
        item_master = S41_ADDENDUM["functions"][0]
        self.assertEqual(item_master["name"], "atlas-item-master")
        self.assertFalse(item_master["verify_jwt"])
        self.assertEqual(S41_ADDENDUM["boundaries"], {
            "real_stock_writes_authorized": False,
            "item_master_publication_enabled": False,
            "wildcard_cors_allowed": False,
        })
        for relative, expected in item_master["sources"].items():
            self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected)

    def test_builder_rejects_unsafe_origins_and_repository_output(self):
        builder = load_builder()
        for origin in (
            "http://os-vabar.netlify.app",
            "https://*.example.com",
            "https://atialqebqxcquzdkezln.supabase.co",
            "https://atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site",
        ):
            with self.assertRaises(ValueError):
                builder.build(Path(tempfile.gettempdir()) / "unused-s39-output", origin)
        with self.assertRaises(ValueError):
            builder.build(ROOT / "dist-s39", "https://os-vabar.netlify.app")

    def test_docs_separate_every_production_gate(self):
        for phrase in (
            "Git-only preparation package", "Real-stock preservation", "Database",
            "Functions", "Read-only acceptance", "Endpoint cutover", "Controlled activation",
        ):
            self.assertIn(phrase, PACKAGE_DOC)

    def test_disposable_dry_run_is_loopback_only_and_exact(self):
        self.assertIn("127.0.0.1|localhost|::1", DRY_RUN)
        self.assertIn("Refusing S39 production-launch dry run against non-loopback PGHOST", DRY_RUN)
        self.assertIn("verify_production_adoption_dry_run.sh", DRY_RUN)
        for item in MANIFEST["migration_plan"][1:]:
            self.assertIn(item["path"], DRY_RUN)
        self.assertNotIn("supabase db push", DRY_RUN)
        self.assertNotIn("supabase functions deploy", DRY_RUN)

    def test_ci_has_no_hosted_credentials_or_mutation_commands(self):
        lowered = WORKFLOW.lower()
        self.assertIn("build_s39_production_runtime.py", lowered)
        self.assertIn("verify_s39_production_launch_dry_run.sh", lowered)
        self.assertNotIn("supabase_access_token", lowered)
        self.assertNotIn("database_url", lowered)
        self.assertNotIn("supabase db push", lowered)
        self.assertNotIn("supabase functions deploy", lowered)


if __name__ == "__main__":
    unittest.main()
