from pathlib import Path
import os
import json
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
REPLAY = (ROOT / "scripts/verify_full_migration_replay.sh").read_text()


class MigrationReplayContractTests(unittest.TestCase):
    def test_pgcrypto_matches_supabase_extensions_schema(self):
        self.assertIn(
            "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;",
            REPLAY,
        )
        self.assertNotIn(
            "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;",
            REPLAY,
        )

    def test_replay_stops_if_pgcrypto_is_installed_elsewhere(self):
        self.assertIn("from pg_extension e join pg_namespace n", REPLAY)
        self.assertIn('if [[ "$pgcrypto_schema" != "extensions" ]]', REPLAY)

    def test_remote_host_is_rejected_before_psql_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "psql-called"
            psql = Path(directory) / "psql"
            psql.write_text(f'#!/bin/sh\ntouch "{marker}"\n')
            psql.chmod(0o755)
            result = subprocess.run(
                ["bash", str(ROOT / "scripts/verify_full_migration_replay.sh")],
                env={**os.environ, "PGHOST": "remote.invalid",
                     "PATH": directory + os.pathsep + os.environ["PATH"]},
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Refusing migration replay", result.stderr)
            self.assertFalse(marker.exists())

    def test_only_flattened_alternative_is_excluded_and_tested_separately(self):
        manifest = json.loads((ROOT / "supabase/production-adoption/manifest.json").read_text())
        flattened = manifest["flattened_migration"]
        self.assertIn(f"! -name '{Path(flattened).name}'", REPLAY)
        self.assertEqual(REPLAY.count("! -name"), 1)
        adoption = (ROOT / "scripts/verify_production_adoption_dry_run.sh").read_text()
        workflow = (ROOT / ".github/workflows/production-adoption-dry-run.yml").read_text()
        self.assertIn(f'-f "$ROOT/{flattened}"', adoption)
        self.assertIn("005_local_rls_trigger_fixture.sql", adoption)
        self.assertIn("'supabase/migrations/**'", workflow)
        self.assertIn("bash scripts/verify_production_adoption_dry_run.sh", workflow)
        self.assertIn('assert state["ledger_count"] == expected_migration_count', REPLAY)

    def test_historical_replay_executes_every_other_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "calls.jsonl"
            psql = Path(directory) / "psql"
            psql.write_text(
                "#!/usr/bin/env python3\nimport json, sys\n"
                f"with open({str(log)!r}, 'a') as log: log.write(json.dumps(sys.argv[1:]) + '\\n')\n"
                "if any('from pg_extension' in arg for arg in sys.argv): print('extensions')\n"
            )
            psql.chmod(0o755)
            result = subprocess.run(
                ["bash", str(ROOT / "scripts/verify_full_migration_replay.sh")],
                env={**os.environ, "PGHOST": "127.0.0.1", "ATLAS_BOOTSTRAP_ONLY": "0",
                     "RUNNER_TEMP": directory,
                     "PATH": directory + os.pathsep + os.environ["PATH"]},
                capture_output=True, text=True,
            )
            # The fake client runs no SQL, so final acceptance must fail closed.
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("No JSON result found", result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            applied = [Path(args[args.index("-f") + 1]).name for args in calls
                       if "-f" in args and "/supabase/migrations/" in args[args.index("-f") + 1]]
            expected = sorted(path.name for path in (ROOT / "supabase/migrations").glob("*.sql")
                              if path.name != "20260910094217_atlas_phase1_production_adoption.sql")
            self.assertTrue(expected)
            self.assertEqual(applied, expected)


if __name__ == "__main__":
    unittest.main()
