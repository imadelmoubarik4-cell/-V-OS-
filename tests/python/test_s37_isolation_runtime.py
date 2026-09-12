import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BUILDER_PATH = ROOT / "scripts/build_s37_isolated_runtime.py"
MANIFEST_PATH = ROOT / "docs/release/Atlas_S35_Combined_Isolated_Staging_Manifest.json"
spec = importlib.util.spec_from_file_location("s37_runtime", BUILDER_PATH)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class S37IsolationRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_manifest_requires_generated_isolated_artifact(self):
        isolation = self.manifest["runtime_isolation"]
        self.assertEqual(isolation["builder_path"], str(BUILDER_PATH.relative_to(ROOT)))
        self.assertEqual(isolation["target_origin"], builder.TARGET_ORIGIN)
        self.assertEqual(isolation["allowed_browser_origin"], builder.PREVIEW_ORIGIN)
        self.assertTrue(isolation["deploy_generated_artifact_only"])
        self.assertFalse(isolation["production_fallbacks_allowed"])
        self.assertFalse(isolation["wildcard_cors_allowed"])

    def test_builder_generates_exact_fail_closed_scope(self):
        sources = {
            source: (ROOT / source).read_bytes()
            for function in self.manifest["functions"]
            for source in function["sources"]
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "runtime"
            result = builder.build(output)
            self.assertEqual(result["functions"], 18)
            self.assertEqual(result["files"], 22)
            runtime = json.loads((output / "runtime-manifest.json").read_text())
            self.assertEqual(len(runtime["functions"]), 18)
            self.assertFalse(runtime["production_fallbacks"])
            self.assertFalse(runtime["wildcard_cors"])

            for function in runtime["functions"]:
                entrypoint = output / function["entrypoint"]
                self.assertTrue(entrypoint.read_text().startswith("// S37 staging boundary:"))
                for item in function["files"]:
                    generated = (output / item["path"]).read_text()
                    self.assertNotIn(
                        "${AUTH_PROJECT_URL}/rest/v1/",
                        generated,
                    )
                    self.assertNotRegex(
                        generated,
                        r"\bproduction(?:Origin|Json|Rows|Profiles|Inventory|Headers|Source|Sources)\b",
                    )
                    self.assertNotIn('"production-', generated)
                    self.assertNotIn('"Production ', generated)
                    self.assertNotIn("Stock-count production ", generated)
                    for line in generated.splitlines():
                        if line.lstrip().startswith("//"):
                            self.assertNotRegex(line, r"\b[Pp]roduction\b")
                    for ref in builder.FORBIDDEN_PROJECT_REFS:
                        self.assertNotIn(ref, generated)
                    self.assertNotRegex(
                        generated,
                        r'access-control-allow-origin["\']?\s*:\s*["\']\*["\']',
                    )
                    if "access-control-allow-origin" in generated.lower():
                        self.assertIn(builder.PREVIEW_ORIGIN, generated)

            intelligence = (
                output / "functions/atlas-phase3-intelligence/index.ts"
            ).read_text()
            self.assertNotIn("productionRows", intelligence)
            self.assertNotIn("production_rest_snapshot", intelligence)
            self.assertNotIn("production_source_mutation", intelligence)
            self.assertIn(
                "${S37_TARGET_ORIGIN}/rest/v1/",
                intelligence,
            )

            config = (output / "config.toml").read_text()
            notification_block = config.split(
                "[functions.atlas-notifications]", 1
            )[1].split("\n\n", 1)[0]
            self.assertIn("verify_jwt = true", notification_block)
            self.assertEqual(config.count("verify_jwt = true"), 1)
            self.assertEqual(config.count("verify_jwt = false"), 17)

        for source, original in sources.items():
            self.assertEqual((ROOT / source).read_bytes(), original)

    def test_builder_refuses_repo_overwrite_and_existing_output(self):
        with self.assertRaises(ValueError):
            builder.build(ROOT / "supabase" / "s37-runtime")
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "existing"
            existing.mkdir()
            with self.assertRaises(ValueError):
                builder.build(existing)


if __name__ == "__main__":
    unittest.main()
