from pathlib import Path
import os
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

    def test_adoption_fixture_precedes_flattened_migration_only(self):
        loop = REPLAY.split('for migration in "${migrations[@]}"; do', 1)[1]
        fixture = "supabase/production-adoption/sql/005_local_rls_trigger_fixture.sql"
        self.assertIn(
            'if [[ "$base" == "20260910094217_atlas_phase1_production_adoption.sql" ]]; then',
            loop,
        )
        self.assertLess(loop.index(fixture), loop.index('echo "Applying $base"'))
        self.assertIn('psql -v ON_ERROR_STOP=1 -q -f "$migration"', loop)
        self.assertIn('assert state["ledger_count"] == expected_migration_count', loop)
        self.assertIn('assert state["ensure_rls_enabled"] is True', loop)
        self.assertIn('assert state["rls_auto_enable_browser_execute"] is False', loop)


if __name__ == "__main__":
    unittest.main()
