import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('rehearsal_build', ROOT / 'scripts/build_isolated_rehearsal.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class IsolatedRehearsalBuildTests(unittest.TestCase):
    def test_artifact_is_isolated_and_does_not_modify_source(self):
        original = (ROOT / 'apps/web/config.js').read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            output = builder.build(Path(directory) / 'web', 'sb_publishable_synthetic')
            config = (output / 'config.js').read_text()
            headers = (output / '_headers').read_text()
            manifest = json.loads((output / 'rehearsal-manifest.json').read_text())
            self.assertIn(builder.TARGET, config)
            self.assertEqual(len(manifest['disabled_runtime_settings']), 16)
            for forbidden in ('dnefgcmjcgxlynycxkts', 'uhbamqetppqmygesoeeh'):
                self.assertNotIn(forbidden, config)
                self.assertNotIn(forbidden, headers)
            self.assertNotIn('loadAtlasAsset', config)
            self.assertNotIn('src="assets/js/brain.js"', (output / 'index.html').read_text())
            self.assertTrue((output / 'recovery.html').exists())
            self.assertEqual((ROOT / 'apps/web/config.js').read_bytes(), original)

    def test_refuses_secret_keys_and_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            for key in ('sb_secret_sensitive', 'eyJ.synthetic.jwt', ''):
                with self.assertRaises(ValueError): builder.build(Path(directory) / 'web', key)
            with self.assertRaises(ValueError): builder.build(directory, 'sb_publishable_synthetic')
        with self.assertRaises(ValueError): builder.build(ROOT / 'apps/web', 'sb_publishable_synthetic')
