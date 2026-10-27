"""S114 staff access state: the reviewed production release artifacts.

- the apply bundle embeds the migration byte for byte, refuses unless S113 is
  recorded and S114 is not, and records the ledger row in the same transaction;
- the migration only adds two read-only, service-role-only functions;
- the rollback removes exactly those functions and the ledger row;
- the pre-flight is read-only (a read-only transaction, rolled back, no writes).
"""
import pathlib
import re
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20261031090000_s114_staff_access_state.sql"
BUNDLE = ROOT / "docs/release/sql/S114_apply_staff_access_state.sql"
ROLLBACK = ROOT / "docs/release/sql/S114_staff_access_state_rollback.sql"
PREFLIGHT = ROOT / "docs/release/sql/S114_preflight_readonly.sql"
GENERATOR = ROOT / "scripts/release/generate_s114_staff_access_bundle.py"


def code_only(sql):
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


class S114StaffAccessRelease(unittest.TestCase):
    def test_bundle_is_generated_and_embeds_the_migration_verbatim(self):
        before = BUNDLE.read_bytes()
        subprocess.run([sys.executable, str(GENERATOR)], check=True, capture_output=True)
        self.assertEqual(BUNDLE.read_bytes(), before, "the committed bundle is exactly what the generator writes")
        text = BUNDLE.read_text(encoding="utf-8")
        body = text.split("-- >>> migration file (verbatim) >>>\n", 1)[1].split("\n-- <<< end of migration file <<<", 1)[0]
        self.assertEqual(body, MIGRATION.read_text(encoding="utf-8").rstrip())

    def test_bundle_guard_and_ledger_commit_together(self):
        text = code_only(BUNDLE.read_text(encoding="utf-8"))
        self.assertIn("where version = '20261030090000') then\n    raise exception 'S114 apply refused: previous migration", text)
        self.assertIn("where version = '20261031090000') then\n    raise exception 'S114 apply refused: 20261031090000 is already recorded", text)
        self.assertIn("values ('20261031090000', 's114_staff_access_state', array[]::text[]);", text)
        self.assertLess(text.index("begin;"), text.index("$guard$"))
        self.assertLess(text.index("insert into supabase_migrations.schema_migrations"), text.index("commit;"))
        self.assertNotIn("supabase db push", code_only(text))

    def test_migration_adds_only_sealed_read_only_functions(self):
        sql = code_only(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(sorted(set(re.findall(r"create or replace function ([\w.]+)\(", sql))),
                         ["atlas_private.team_profile_access_state", "public.atlas_team_profile_access_state"])
        for statement in ("create table", "alter table", "create policy", "drop ", "insert ", "update ", "delete "):
            self.assertNotIn(statement, sql.lower())
        self.assertEqual(sql.count("security definer"), 2)
        self.assertEqual(sql.count("set search_path = ''"), 2)
        self.assertEqual(sql.count("stable"), 2)
        for name in ("atlas_private.team_profile_access_state(uuid)", "public.atlas_team_profile_access_state(uuid)"):
            self.assertIn(f"revoke all on function {name} from public, anon, authenticated;", sql)
            self.assertIn(f"grant execute on function {name} to service_role;", sql)
        self.assertNotRegex(sql, r"grant execute[^;]*to (anon|authenticated|public)")

    def test_rollback_removes_exactly_s114(self):
        sql = code_only(ROLLBACK.read_text(encoding="utf-8"))
        self.assertIn("drop function if exists public.atlas_team_profile_access_state(uuid);", sql)
        self.assertIn("drop function if exists atlas_private.team_profile_access_state(uuid);", sql)
        self.assertIn("delete from supabase_migrations.schema_migrations where version = '20261031090000';", sql)
        self.assertEqual(len(re.findall(r"\bdrop\b", sql)), 2)
        self.assertEqual(len(re.findall(r"\bdelete\b", sql)), 1)
        self.assertLess(sql.index("begin;"), sql.index("drop function"))
        self.assertLess(sql.index("delete from"), sql.index("commit;"))

    def test_preflight_is_read_only(self):
        sql = code_only(PREFLIGHT.read_text(encoding="utf-8")).lower()
        self.assertIn("begin transaction read only;", sql)
        self.assertTrue(sql.rstrip().endswith("rollback;"))
        for keyword in ("insert ", "update ", "delete ", "drop ", "alter ", "create ", "grant ", "revoke ", "truncate "):
            self.assertNotIn(keyword, sql)
        # Ids only: no names or email addresses are selected.
        self.assertNotRegex(sql, r"select[^;]*\b(email|display_name|full_name|phone)\b[^;]*from public\.profiles")


if __name__ == "__main__":
    unittest.main()
