from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
