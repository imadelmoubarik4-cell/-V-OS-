import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from scripts.build_isolated_runtime import build, GUARD, transform


class IsolatedRuntimeTests(unittest.TestCase):
    def test_reproduces_reviewed_sources_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'runtime'
            result = build(target)
            self.assertEqual(result['files'], 18)
            config = (target / 'config.toml').read_text()
            self.assertIn('atlas-reports/entrypoint.ts', config)
            self.assertIn('atlas-stock-counts/entrypoint.ts', config)
            with self.assertRaises(ValueError):
                build(target)

    def test_configuration_fails_closed_before_registration(self):
        valid = {'SUPABASE_URL': 'https://atialqebqxcquzdkezln.supabase.co',
                 'ATLAS_AUTH_PROJECT_URL': 'https://atialqebqxcquzdkezln.supabase.co',
                 'ATLAS_AUTH_PUBLISHABLE_KEY': 'sb_publishable_synthetic'}
        cases = [(valid, True)]
        for key in valid:
            missing = dict(valid)
            missing.pop(key)
            cases += [(missing, False), (dict(valid, **{key: 'wrong'}), False)]
        for env, accepted in cases:
            code = 'const e=' + json.dumps(env) + ';const Deno={env:{get:n=>e[n]}};\n' + GUARD
            result = subprocess.run(['node', '--input-type=module', '-e', code], capture_output=True)
            self.assertEqual(result.returncode == 0, accepted)

    def test_unexpected_production_reference_is_rejected(self):
        with self.assertRaises(ValueError):
            transform('fetch("https://dnefgcmjcgxlynycxkts.supabase.co/rest/v1/profiles")')
