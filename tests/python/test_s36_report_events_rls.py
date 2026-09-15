import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    ROOT / "supabase/migrations/20260911160616_s36_report_events_rls.sql"
)
MANIFEST_PATH = (
    ROOT / "docs/release/Atlas_S35_Combined_Isolated_Staging_Manifest.json"
)


class S36ReportEventsRlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION_PATH.read_text(encoding="utf-8")
        cls.lowered = cls.sql.lower()
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_hardening_is_replay_safe_and_scoped_to_existing_table(self):
        self.assertIn(
            "to_regclass('atlas_private.report_events') is not null",
            self.lowered,
        )
        self.assertEqual(self.lowered.count("enable row level security"), 1)
        self.assertNotRegex(self.lowered, r"\b(create|drop)\s+table\b")
        self.assertNotRegex(self.lowered, r"\b(insert\s+into|update|delete\s+from)\b")
        self.assertNotIn("force row level security", self.lowered)

    def test_access_is_service_role_only_and_least_privilege(self):
        self.assertIn(
            "revoke all on table atlas_private.report_events from public, anon, authenticated, service_role",
            self.lowered,
        )
        self.assertIn(
            "grant select, insert on table atlas_private.report_events to service_role",
            self.lowered,
        )
        self.assertNotRegex(
            self.lowered,
            r"grant\s+[^;]+\s+to\s+(anon|authenticated)\b",
        )
        self.assertNotRegex(
            self.lowered,
            r"grant\s+[^;]*(update|delete|truncate|references|trigger)[^;]*to\s+service_role",
        )

    def test_exact_select_and_insert_policies_are_idempotent(self):
        policies = re.findall(
            r"create policy \"([^\"]+)\" on atlas_private\.report_events "
            r"for (select|insert) to service_role (using|with check) \(true\)",
            self.lowered,
        )
        self.assertEqual(
            [
                ("service role reads report events", "select", "using"),
                ("service role inserts report events", "insert", "with check"),
            ],
            policies,
        )
        for name, _, _ in policies:
            self.assertIn(
                f'drop policy if exists "{name}" on atlas_private.report_events',
                self.lowered,
            )
        self.assertNotRegex(
            self.lowered,
            r"create policy[^;]+\bto\s+(anon|authenticated)\b",
        )

    def test_s35_manifest_includes_exact_s36_overlay(self):
        migration = self.manifest["migrations"][-1]
        self.assertEqual(migration["order"], 6)
        self.assertEqual(migration["path"], str(MIGRATION_PATH.relative_to(ROOT)))
        self.assertEqual(
            migration["sha256"],
            hashlib.sha256(MIGRATION_PATH.read_bytes()).hexdigest(),
        )
        fix = self.manifest["security_remediation"]
        self.assertEqual(fix["table"], "atlas_private.report_events")
        self.assertEqual(fix["allowed_role"], "service_role")
        self.assertEqual(fix["allowed_privileges"], ["select", "insert"])
        self.assertFalse(fix["hosted_execution_performed"])


if __name__ == "__main__":
    unittest.main()
