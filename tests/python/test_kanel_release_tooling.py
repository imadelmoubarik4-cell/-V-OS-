"""KANEL bookings release tooling (S106–S113, incl. S110b) — static contract.

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
S106_S109 = [p for p in RELEASE_MIGRATIONS if p.name.split("_")[0] < "20261027000000"]
BUNDLES = sorted((ROOT / "docs/release/sql").glob("KANEL_apply_[1-9]_*.sql"))
EXPECTED_110 = json.loads((ROOT / "scripts/release/kanel_pre_s110_expected.json").read_text(encoding="utf-8"))
ROLLBACK_110 = (ROOT / "docs/release/sql/KANEL_S110_rollback.sql").read_text(encoding="utf-8")
PREFLIGHT_110 = (ROOT / "docs/release/sql/KANEL_S110_preflight_readonly.sql").read_text(encoding="utf-8")
ROLLBACK_111 = (ROOT / "docs/release/sql/KANEL_S111_rollback.sql").read_text(encoding="utf-8")
PREFLIGHT_111 = (ROOT / "docs/release/sql/KANEL_S111_preflight_readonly.sql").read_text(encoding="utf-8")
ROLLBACK_110B = (ROOT / "docs/release/sql/KANEL_S110b_rollback.sql").read_text(encoding="utf-8")
PREFLIGHT_110B = (ROOT / "docs/release/sql/KANEL_S110b_preflight_readonly.sql").read_text(encoding="utf-8")
EXPECTED_112 = json.loads((ROOT / "scripts/release/kanel_pre_s112_expected.json").read_text(encoding="utf-8"))
ROLLBACK_112 = (ROOT / "docs/release/sql/KANEL_S112_rollback.sql").read_text(encoding="utf-8")
PREFLIGHT_112 = (ROOT / "docs/release/sql/KANEL_S112_preflight_readonly.sql").read_text(encoding="utf-8")
EXPECTED_113 = json.loads((ROOT / "scripts/release/kanel_pre_s113_expected.json").read_text(encoding="utf-8"))
ROLLBACK_113 = (ROOT / "docs/release/sql/KANEL_S113_rollback.sql").read_text(encoding="utf-8")
PREFLIGHT_113 = (ROOT / "docs/release/sql/KANEL_S113_preflight_readonly.sql").read_text(encoding="utf-8")
SCHEDULE_113 = (ROOT / "scripts/kanel_booking_email_schedule_install.sql").read_text(encoding="utf-8")
S109_SQL = (ROOT / "supabase/migrations/20261026090000_s109_booking_notifications_inbox.sql").read_text(encoding="utf-8")


def code_only(sql):
    """SQL with comments and string literals removed."""
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


class KanelReleaseTooling(unittest.TestCase):
    def test_preflight_is_strictly_read_only(self):
        for name, text in (("S106", PREFLIGHT), ("S110", PREFLIGHT_110), ("S110b", PREFLIGHT_110B), ("S111", PREFLIGHT_111), ("S112", PREFLIGHT_112), ("S113", PREFLIGHT_113)):
            code = code_only(text).lower()
            for word in ("insert", "update", "delete", "alter", "drop", "create", "grant", "revoke",
                         "truncate", "copy", "call", "do", "set ", "begin", "commit", "vacuum"):
                self.assertIsNone(re.search(rf"\b{word.strip()}\b", code), f"{name} preflight contains {word.strip()!r}")
            self.assertEqual(code.count(";"), 1, f"{name} preflight is a single statement")

    def test_s110_preflight_checks_every_touched_function_against_s109(self):
        for key, want in EXPECTED_110["restored_functions"].items():
            self.assertIn(want["src_md5"], PREFLIGHT_110, key)
            self.assertIn(want["acl"].replace("'", "''"), PREFLIGHT_110, key)
        self.assertIn("'20261026090000'", PREFLIGHT_110)  # production must be at S109
        self.assertIn("booking_check_seat_group", PREFLIGHT_110)

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

    def test_s106_s109_rollback_refuses_while_s110_is_recorded(self):
        guard = ROLLBACK.index("version >= '20261027000000'")
        self.assertLess(ROLLBACK.index("begin;"), guard)
        self.assertLess(guard, ROLLBACK.index("drop trigger if exists"))

    def test_s110_rollback_restores_s109_and_drops_only_the_helper(self):
        code = code_only(ROLLBACK_110)
        self.assertEqual(code.count("begin;"), 1)
        self.assertTrue(code.rstrip().endswith("commit;"))
        self.assertEqual(len(EXPECTED_110["restored_functions"]), 3)
        for key in EXPECTED_110["restored_functions"]:
            self.assertIn(f"CREATE OR REPLACE FUNCTION {key.split('(')[0]}(", ROLLBACK_110, key)
        self.assertEqual(EXPECTED_110["release_functions"], [k for k in EXPECTED_110["release_functions"] if "booking_check_seat_group" in k])
        self.assertIn("drop function if exists atlas_private.booking_check_seat_group(", ROLLBACK_110)
        self.assertIn("delete from supabase_migrations.schema_migrations where version = '20261027090000';", ROLLBACK_110)
        for line in ROLLBACK_110.splitlines():
            self.assertIsNone(re.search(r"\b(drop (table|column)|truncate|delete from atlas_private)\b", line, re.I), line)

    def test_s111_preflight_requires_s110_and_pg_cron(self):
        self.assertIn("'20261027120000'", PREFLIGHT_111)  # production must be at S110b
        self.assertIn("'20261028090000'", PREFLIGHT_111)
        self.assertIn("pg_available_extensions where name = 'pg_cron'", PREFLIGHT_111)

    def test_s110b_preflight_pins_the_s109_inbox_rpc(self):
        self.assertIn("'20261027090000'", PREFLIGHT_110B)  # production must be at S110
        self.assertIn("'20261027120000'", PREFLIGHT_110B)
        self.assertIn("'ad9b5f669b08363c5ce9c1b3ba934cf1'", PREFLIGHT_110B)  # md5 of the S109 definition

    def test_s110b_rollback_restores_the_s109_inbox_rpc_verbatim(self):
        code = code_only(ROLLBACK_110B)
        self.assertEqual(code.count("begin;"), 1)
        self.assertTrue(code.rstrip().endswith("commit;"))
        start = S109_SQL.index("create or replace function public.atlas_bookings_notifications(")
        end = S109_SQL.index("to service_role;", start) + len("to service_role;")
        self.assertIn(S109_SQL[start:end], ROLLBACK_110B)
        self.assertLess(ROLLBACK_110B.index("version >= '20261028000000'"), ROLLBACK_110B.index("create or replace function"))
        self.assertIn("delete from supabase_migrations.schema_migrations where version = '20261027120000';", ROLLBACK_110B)
        for line in ROLLBACK_110B.splitlines():
            self.assertIsNone(re.search(r"\b(drop|truncate|delete from atlas_private|update atlas_private)\b", line, re.I), line)

    def test_s111_rollback_unschedules_and_drops_only_s111_objects(self):
        code = code_only(ROLLBACK_111)
        self.assertEqual(code.count("begin;"), 1)
        self.assertTrue(code.rstrip().endswith("commit;"))
        self.assertIn("cron.unschedule", ROLLBACK_111)
        self.assertIn("drop function if exists atlas_private.booking_purge_personal_data(integer, boolean);", ROLLBACK_111)
        self.assertIn("drop table if exists atlas_private.booking_retention_runs;", ROLLBACK_111)
        self.assertIn("delete from supabase_migrations.schema_migrations where version = '20261028090000';", ROLLBACK_111)
        for line in ROLLBACK_111.splitlines():
            if re.search(r"\b(drop table|truncate|delete from)\b", line, re.I) and not line.lstrip().startswith("--"):
                self.assertTrue("booking_retention_runs" in line or "schema_migrations" in line, line)

    def test_s111_rollback_refuses_while_s112_is_recorded(self):
        guard = ROLLBACK_111.index("version >= '20261029000000'")
        self.assertLess(ROLLBACK_111.index("begin;"), guard)
        self.assertLess(guard, ROLLBACK_111.index("drop function if exists"))

    def test_s112_preflight_checks_every_touched_function_and_the_stools(self):
        for key, want in EXPECTED_112["restored_functions"].items():
            self.assertIn(want["src_md5"], PREFLIGHT_112, key)
            self.assertIn(want["acl"].replace("'", "''"), PREFLIGHT_112, key)
        self.assertIn("'20261028090000'", PREFLIGHT_112)  # production must be at S111
        self.assertIn("'20261029090000'", PREFLIGHT_112)
        self.assertIn("public_instant_confirm", PREFLIGHT_112)
        for n in range(1, 17):  # every seeded stool is checked by id
            self.assertIn(f"('bb000000-0000-4000-8000-0000000000{n:02d}'::uuid, {n})", PREFLIGHT_112)

    def test_s112_rollback_restores_s111_and_the_stool_numbering(self):
        code = code_only(ROLLBACK_112)
        self.assertEqual(code.count("begin;"), 1)
        self.assertTrue(code.rstrip().endswith("commit;"))
        self.assertEqual(len(EXPECTED_112["restored_functions"]), 3)
        for key in EXPECTED_112["restored_functions"]:
            self.assertIn(f"CREATE OR REPLACE FUNCTION {key.split('(')[0]}(", ROLLBACK_112, key)
        self.assertEqual(len(EXPECTED_112["release_functions"]), 4)
        for key in EXPECTED_112["release_functions"]:
            self.assertIn(f"drop function if exists {key.split('(')[0]}(", ROLLBACK_112, key)
        self.assertLess(ROLLBACK_112.index("version > '20261029090000'"), ROLLBACK_112.index("CREATE OR REPLACE FUNCTION"))
        self.assertIn("when t.position_index <= 8 then 'A' when t.position_index <= 12 then 'B' else 'C'", ROLLBACK_112)
        self.assertIn("update atlas_private.booking_settings set public_instant_confirm = false where id = true;", ROLLBACK_112)
        self.assertIn("delete from supabase_migrations.schema_migrations where version = '20261029090000';", ROLLBACK_112)
        for line in ROLLBACK_112.splitlines():
            if line.lstrip().startswith("--"):
                continue
            self.assertIsNone(re.search(r"\b(drop (table|column)|truncate|delete from atlas_private)\b", line, re.I), line)

    def test_s113_preflight_checks_the_touched_function_and_outbox_rule(self):
        for key, want in EXPECTED_113["restored_functions"].items():
            self.assertIn(want["src_md5"], PREFLIGHT_113, key)
            self.assertIn(want["acl"].replace("'", "''"), PREFLIGHT_113, key)
        for key, want in EXPECTED_113["restored_constraints"].items():
            self.assertIn(want.replace("'", "''"), PREFLIGHT_113, key)
        self.assertIn("'20261029090000'", PREFLIGHT_113)  # production must be at S112
        self.assertIn("'20261030090000'", PREFLIGHT_113)
        self.assertIn("guest_email_enabled", PREFLIGHT_113)

    def test_s113_rollback_restores_s112_and_keeps_guest_data(self):
        code = code_only(ROLLBACK_113)
        self.assertEqual(code.count("begin;"), 1)
        self.assertTrue(code.rstrip().endswith("commit;"))
        self.assertEqual(list(EXPECTED_113["restored_functions"]), ["public.atlas_public_booking_request(p_payload jsonb)"])
        self.assertIn("CREATE OR REPLACE FUNCTION public.atlas_public_booking_request(", ROLLBACK_113)
        self.assertEqual(len(EXPECTED_113["release_functions"]), 8)
        for key in EXPECTED_113["release_functions"]:
            self.assertIn(f"drop function if exists {key.split('(')[0]}(", ROLLBACK_113, key)
        self.assertEqual(EXPECTED_113["release_triggers"], ["atlas_private.booking_settings.booking_settings_guest_email_since"])
        # Trigger before its function; schedule stopped before the tick is dropped; guard first.
        self.assertLess(ROLLBACK_113.index("drop trigger if exists booking_settings_guest_email_since"),
                        ROLLBACK_113.index("drop function if exists atlas_private.booking_settings_guest_email_since("))
        self.assertIn("execute 'select cron.unschedule($1)' using 'kanel-booking-email';", ROLLBACK_113)
        self.assertLess(ROLLBACK_113.index("cron.unschedule"),
                        ROLLBACK_113.index("drop function if exists atlas_private.booking_email_tick("))
        self.assertLess(ROLLBACK_113.index("version > '20261030090000'"), ROLLBACK_113.index("cron.unschedule"))
        self.assertIn("update atlas_private.booking_settings set guest_email_enabled = false where id = true;", ROLLBACK_113)
        self.assertIn("delete from supabase_migrations.schema_migrations where version = '20261030090000';", ROLLBACK_113)
        # Only test emails are deleted; columns are kept unless uncommented.
        for line in ROLLBACK_113.splitlines():
            if line.lstrip().startswith("--"):
                continue
            self.assertIsNone(re.search(r"\b(drop (table|column)|truncate)\b", line, re.I), line)
            if re.search(r"\bdelete from atlas_private\b", line, re.I):
                self.assertEqual(line, "delete from atlas_private.booking_email_outbox where kind = 'test';")
        self.assertLess(ROLLBACK_113.index("where kind = 'test'"), ROLLBACK_113.index("add constraint booking_email_outbox_kind_check"))

    def test_s113_schedule_install_never_prints_a_secret(self):
        self.assertIn("kanel_booking_email_worker_secret", SCHEDULE_113)
        self.assertIn("select cron.schedule(", SCHEDULE_113)
        self.assertIn("'kanel-booking-email'", SCHEDULE_113)
        self.assertNotIn("dnefgcmjcgxlynycxkts", SCHEDULE_113)
        self.assertIsNone(re.search(r"select[^;]*decrypted_secret[^;]*;\s*$", code_only(SCHEDULE_113), re.I | re.M))

    def test_rollback_clears_exactly_the_release_ledger_rows(self):
        versions = [p.name.split("_")[0] for p in S106_S109]
        self.assertEqual(versions, ["20261023090000", "20261024090000", "20261025090000", "20261026090000"])
        self.assertIn("delete from supabase_migrations.schema_migrations\n where version in ("
                      + ", ".join(f"'{v}'" for v in versions) + ");", ROLLBACK)
        self.assertLess(ROLLBACK.index("delete from supabase_migrations"), ROLLBACK.index("commit;"))

    def test_apply_bundles_embed_each_migration_verbatim_in_order(self):
        self.assertEqual(len(BUNDLES), len(RELEASE_MIGRATIONS))
        self.assertEqual([p.name.split("_")[0] for p in RELEASE_MIGRATIONS][-1], "20261030090000")
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
