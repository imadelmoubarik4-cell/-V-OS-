import hashlib
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads(
    (ROOT / "docs/release/Atlas_S42_Production_Cutover_Manifest.json").read_text(encoding="utf-8")
)
CONFIG = (ROOT / "apps/web/config.js").read_text(encoding="utf-8")


class S42ProductionCutoverTests(unittest.TestCase):
    def test_cutover_files_are_checksum_pinned(self):
        for relative, expected in MANIFEST["files"].items():
            self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected)

    def test_every_active_endpoint_uses_production(self):
        origin = MANIFEST["production"]["supabase_origin"]
        endpoints = re.findall(r'^\s*[A-Z0-9_]+_API:\s*"([^"]*)"', CONFIG, re.MULTILINE)
        active = [endpoint for endpoint in endpoints if endpoint]
        self.assertEqual(len(active), MANIFEST["production"]["configured_frontend_endpoint_count"])
        self.assertTrue(all(endpoint.startswith(f"{origin}/functions/v1/atlas-") for endpoint in active))
        self.assertRegex(CONFIG, r'MODE:\s*"production"')
        self.assertRegex(CONFIG, r'IMPORT_WORKER_API:\s*""')

    def test_web_bundle_contains_no_staging_target(self):
        text_suffixes = {".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".webmanifest"}
        sources = [
            path.read_text(encoding="utf-8")
            for path in (ROOT / "apps/web").rglob("*")
            if path.is_file() and path.suffix.lower() in text_suffixes
        ]
        combined = "\n".join(sources) + (ROOT / "netlify.toml").read_text(encoding="utf-8")
        for forbidden in ("uhbamqetppqmygesoeeh", "atialqebqxcquzdkezln", "cwazoxupbwxnixpmmlhx"):
            self.assertNotIn(forbidden, combined)
        self.assertNotRegex(combined, r'access-control-allow-origin["\']?\s*:\s*["\']\*')

    def test_write_feature_boundaries_remain_disabled(self):
        self.assertEqual(MANIFEST["inactive_features"], {
            "import_worker": True,
            "stock_count_publication": True,
            "push_delivery": True,
            "item_master_publication": True,
        })
        self.assertFalse(MANIFEST["boundaries"]["real_stock_mutation_authorized"])
        self.assertFalse(MANIFEST["boundaries"]["automatic_import_authorized"])


if __name__ == "__main__":
    unittest.main()
