import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "docs/release/Atlas_S35_Combined_Isolated_Staging_Manifest.json"
RUNBOOK_PATH = ROOT / "docs/release/Atlas_S35_Combined_Isolated_Staging_Package.md"
EVIDENCE_PATH = ROOT / "docs/release/Atlas_S35_Staging_Evidence_Template.json"
spec = importlib.util.spec_from_file_location("s35_preview", ROOT / "scripts/build_s35_isolated_preview.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class S35StagingPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST_PATH.read_text())

    def test_manifest_fixes_scope_and_safe_defaults(self):
        self.assertEqual(self.manifest["source_merge_commit"], builder.SOURCE_MERGE_COMMIT)
        self.assertEqual(self.manifest["target"]["project_ref"], builder.TARGET)
        self.assertEqual(self.manifest["target"]["preview_origin"], builder.PREVIEW_ORIGIN)
        self.assertEqual([m["order"] for m in self.manifest["migrations"]], [1, 2, 3, 4, 5])
        self.assertEqual(len(self.manifest["functions"]), 18)
        self.assertEqual(len({f["name"] for f in self.manifest["functions"]}), 18)
        boundaries = self.manifest["boundaries"]
        for key in (
            "hosted_execution_authorized",
            "staging_execution_authorized",
            "production_changes",
            "real_staff_data_allowed",
            "production_credentials_allowed",
            "directory_wide_db_push_allowed",
            "push_delivery_default",
        ):
            self.assertFalse(boundaries[key])
        self.assertEqual(
            self.manifest["runtime"]["staging_variables"]["ATLAS_PUSH_DELIVERY_ENABLED"],
            "false",
        )

    def test_all_reviewed_sources_match_manifest_hashes(self):
        for migration in self.manifest["migrations"]:
            path = ROOT / migration["path"]
            self.assertTrue(path.is_file(), migration["path"])
            self.assertEqual(digest(path), migration["sha256"], migration["path"])
        for function in self.manifest["functions"]:
            for source, expected in function["sources"].items():
                path = ROOT / source
                self.assertTrue(path.is_file(), source)
                self.assertEqual(digest(path), expected, source)

    def test_runbook_contains_ordered_controls_and_production_separation(self):
        runbook = RUNBOOK_PATH.read_text()
        for heading in (
            "Read-only preflight",
            "Migrations",
            "Runtime functions and secrets",
            "Owner-private full-app preview",
            "Synthetic full-app acceptance",
            "Controlled notification proof",
            "Recovery proof",
            "Cleanup and closure",
            "Stop conditions",
        ):
            self.assertIn(heading, runbook)
        self.assertIn("Never run a directory-wide database push", runbook)
        self.assertIn("Production release preparation and production approval remain separate", runbook)
        evidence = json.loads(EVIDENCE_PATH.read_text())
        self.assertFalse(evidence["production_touched"])
        self.assertFalse(evidence["decision"]["production_approved"])

    def test_preview_build_is_full_app_isolated_and_non_mutating(self):
        original = (ROOT / "apps/web/config.js").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            output = builder.build(Path(directory) / "web", "sb_publishable_synthetic")
            config = (output / "config.js").read_text()
            headers = (output / "_headers").read_text()
            boundary = (output / "assets/js/rehearsal-boundary.js").read_text()
            manifest = json.loads((output / "rehearsal-manifest.json").read_text())
            self.assertEqual(manifest["runtime_endpoint_count"], 17)
            self.assertFalse(manifest["hosted_setup_performed"])
            self.assertFalse(manifest["notification_delivery_enabled"])
            self.assertFalse(manifest["production_changes"])
            self.assertNotIn("sb_publishable_synthetic", json.dumps(manifest))
            self.assertEqual(config.count(f"https://{builder.TARGET}.supabase.co/functions/v1/"), 18)
            self.assertIn("loadAtlasAsset", config)
            self.assertIn("Runtime modules enabled for this isolated target", boundary)
            self.assertTrue((output / "recovery.html").is_file())
            self.assertIn("X-Robots-Tag: noindex, nofollow", headers)
            for forbidden in builder.FORBIDDEN_REFS:
                self.assertNotIn(forbidden, config)
                self.assertNotIn(forbidden, headers)
            self.assertEqual((ROOT / "apps/web/config.js").read_bytes(), original)

    def test_preview_builder_refuses_secrets_repo_output_and_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            for key in ("sb_secret_sensitive", "eyJ.synthetic.jwt", ""):
                with self.assertRaises(ValueError):
                    builder.build(Path(directory) / "web", key)
            existing = Path(directory) / "exists"
            existing.mkdir()
            with self.assertRaises(ValueError):
                builder.build(existing, "sb_publishable_synthetic")
        with self.assertRaises(ValueError):
            builder.build(ROOT / "apps/web", "sb_publishable_synthetic")


if __name__ == "__main__":
    unittest.main()
