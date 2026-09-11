import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
INDEX = (ROOT / "supabase/migrations/20260911124006_s34_foreign_key_indexes.sql").read_text()
NOTIFICATIONS = (ROOT / "supabase/migrations/20260911124039_s34_notification_and_conversation_stars.sql").read_text()


class S34PreproductionContractTests(unittest.TestCase):
    def test_index_allowlist_is_exact_and_replay_safe(self):
        found = re.findall(
            r"create index if not exists\s+\w+\s+on\s+([\w.]+)\s*\((\w+)\)",
            INDEX,
            flags=re.I,
        )
        expected = [
            ("atlas_private.inventory_count_events", "line_id"),
            ("atlas_private.inventory_count_publication_lines", "count_line_id"),
            ("atlas_private.inventory_count_publication_lines", "session_id"),
            ("atlas_private.inventory_verified_balances", "source_line_id"),
            ("atlas_private.inventory_verified_balances", "source_session_id"),
            ("atlas_private.report_events", "actor_id"),
            ("atlas_private.routine_item_results", "template_item_id"),
            ("public.atlas_media", "uploaded_by"),
            ("public.inventory_movements", "created_by"),
            ("public.inventory_movements", "supplier_id"),
            ("public.onboarding_progress", "completed_by"),
            ("public.recipes", "updated_by"),
        ]
        self.assertEqual(expected, found)
        self.assertEqual(12, INDEX.lower().count("create index if not exists"))
        self.assertIn("to_regclass('atlas_private.report_events')", INDEX)
        self.assertNotRegex(INDEX.lower(), r"\b(drop|alter|delete|update|insert|grant|revoke)\b")

    def test_private_notification_tables_are_rls_protected(self):
        for table in (
            "team_conversation_stars",
            "push_subscriptions",
            "push_notification_queue",
        ):
            self.assertIn(f"alter table atlas_private.{table} enable row level security", NOTIFICATIONS)
            self.assertIn(f"revoke all on atlas_private.{table} from public, anon, authenticated", NOTIFICATIONS)

    def test_notification_delivery_is_narrow_and_server_only(self):
        self.assertIn("event_type in ('team_message','shift_update')", NOTIFICATIONS)
        self.assertIn("route in ('team','shifts')", NOTIFICATIONS)
        self.assertIn("to service_role", NOTIFICATIONS)
        self.assertNotIn("to authenticated", NOTIFICATIONS)
        self.assertNotIn("to anon", NOTIFICATIONS)


if __name__ == "__main__":
    unittest.main()
