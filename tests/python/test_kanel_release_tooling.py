"""KANEL bookings release tooling (S106–S109) — static contract.

The rollback itself is proven on a replayed database by
scripts/release/verify_kanel_bookings_rollback.sh (last step of the replay gate).
This contract keeps the generated files honest between regenerations.
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = json.loads((ROOT / "scripts/release/kanel_pre_s106_expected.json").read_text(encoding="utf-8"))
ROLLBACK = (ROOT / "docs/release/sql/KANEL_S106_S109_rollback.sql").read_text(encoding="utf-8")
PREFLIGHT = (ROOT / "docs/release/sql/KANEL_preflight_readonly.sql").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/migration-replay.yml").read_text(encoding="utf-8")
RELEASE_MIGRATIONS = sorted(p for p in (ROOT / "supabase/migrations").glob("*.sql") if p.name.split("_")[0] > "20261022090000")
BUNDLES = sorted((ROOT / "docs/release/sql").glob("KANEL_apply_[1-4]_*.sql"))


def code_only(sql):
    """SQL with comments and string literals removed."""
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


class KanelReleaseTooling(unittest.TestCase):
    def test_preflight_is_strictly_read_only(self):
        code = code_only(PREFLIGHT).lower()
        for word in ("insert", "update", "delete", "alter", "drop", "create", "grant", "revoke",
                     "truncate", "copy", "call", "do", "set ", "begin", "commit", "vacuum"):
            self.assertIsNone(re.search(rf"\b{word.strip()}\b", code), f"preflight contains {word.strip()!r}")
        self.assertEqual(code.count(";"), 1, "preflight is a single statement")

    def test_preflight_checks_every_restored_object_against_s105(self):
        for key, want in EXPECTED["restored_functions"].items():
            self.assertIn(want["src_md5"], PREFLIGHT, key)
        for key, want in EXPECTED["restored_constraints"].items():
            self.assertIn(want.replace("'", "''"), PREFLIGHT, key)
        self.assertIn("'20261022090000'", PREFLIGHT)  # production must be at S105

    def test_rollback_is_one_transaction_and_covers_every_release_object(self):
        code = code_only(ROLLBACK)
        self.assertEqual(code.count("begin;"), 1)
        self.assertTrue(code.rstrip().endswith("commit;"))
        for key in EXPECTED["release_functions"]:
            self.assertIn(f"drop function if exists {key.split('(')[0]}(", ROLLBACK, key)
        for key in EXPECTED["restored_functions"]:
            self.assertIn(f"CREATE OR REPLACE FUNCTION {key.split('(')[0]}(", ROLLBACK, key)
        self.assertIn("drop trigger if exists booking_lifecycle_notify_trg", ROLLBACK)
        # Release-only queue rows go before the S105 constraints are restored.
        self.assertLess(ROLLBACK.index("delete from atlas_private.push_notification_queue"),
                        ROLLBACK.index("add constraint push_notification_queue_event_type_check"))
        self.assertIn("max_party_online = 30, turnaround_minutes = 0", ROLLBACK)

    def test_rollback_never_drops_data_unless_uncommented(self):
        for line in ROLLBACK.splitlines():
            if re.search(r"\bdrop (table|column)\b", line, re.I):
                self.assertTrue(line.lstrip().startswith("--"), f"destructive statement is active: {line}")

    def test_rollback_clears_exactly_the_release_ledger_rows(self):
        versions = [p.name.split("_")[0] for p in RELEASE_MIGRATIONS]
        self.assertEqual(versions, ["20261023090000", "20261024090000", "20261025090000", "20261026090000"])
        self.assertIn("delete from supabase_migrations.schema_migrations\n where version in ("
                      + ", ".join(f"'{v}'" for v in versions) + ");", ROLLBACK)
        self.assertLess(ROLLBACK.index("delete from supabase_migrations"), ROLLBACK.index("commit;"))

    def test_apply_bundles_embed_each_migration_verbatim_in_order(self):
        self.assertEqual(len(BUNDLES), len(RELEASE_MIGRATIONS))
        prev = "20261022090000"
        for bundle, migration in zip(BUNDLES, RELEASE_MIGRATIONS):
            text = bundle.read_text(encoding="utf-8")
            version = migration.name.split("_")[0]
            body = text.split("-- >>> migration file (verbatim) >>>\n", 1)[1].split("\n-- <<< end of migration file <<<", 1)[0]
            self.assertEqual(body, migration.read_text(encoding="utf-8").rstrip(), bundle.name)
            code = code_only(text)
            self.assertEqual(code.count("begin;"), 1, bundle.name)
            self.assertTrue(code.rstrip().endswith("commit;"), bundle.name)
            # Guard: previous recorded, this one not; ledger row written inside the transaction.
            self.assertIn(f"where version = '{prev}')", text)
            self.assertIn(f"where version = '{version}')", text)
            self.assertIn(f"values ('{version}', '{migration.stem.split('_', 1)[1]}', array[]::text[]);", text)
            # A repeat run must fail loudly (guard + no ON CONFLICT on the ledger row).
            self.assertNotIn("on conflict", text.split("-- <<< end of migration file <<<", 1)[1])
            prev = version

    def test_replay_gate_proves_the_rollback_last(self):
        steps = re.findall(r"run: bash (\S+)", WORKFLOW)
        self.assertEqual(steps[-1], "scripts/release/verify_kanel_bookings_rollback.sh")


if __name__ == "__main__":
    unittest.main()
