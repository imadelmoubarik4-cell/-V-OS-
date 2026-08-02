from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SQL_PATH = ROOT / "supabase" / "drafts" / "20260802_sprint3_review_workflow.sql"


class Sprint3ReviewWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = SQL_PATH.read_text(encoding="utf-8").lower()

    def test_audit_table_and_decision_metadata_exist(self) -> None:
        self.assertIn("create table if not exists atlas_private.review_decisions", self.sql)
        self.assertIn("decision_version integer not null default 0", self.sql)
        self.assertIn("reviewed_at timestamptz", self.sql)
        self.assertIn("decided_by_label text", self.sql)

    def test_decision_functions_are_security_invoker_and_validated(self) -> None:
        self.assertIn("function atlas_private.decide_inventory_row", self.sql)
        self.assertIn("function atlas_private.decide_entity_row", self.sql)
        self.assertGreaterEqual(self.sql.count("security invoker"), 2)
        self.assertIn("approved inventory row requires create, merge, or skip action", self.sql)
        self.assertIn("merge/link approval requires a matched entity", self.sql)
        self.assertIn("for update", self.sql)

    def test_review_views_are_security_invoker(self) -> None:
        self.assertIn("create or replace view atlas_private.review_queue", self.sql)
        self.assertIn("create or replace view atlas_private.review_progress", self.sql)
        self.assertGreaterEqual(self.sql.count("with (security_invoker = true)"), 2)

    def test_browser_roles_receive_no_review_access(self) -> None:
        self.assertIn(
            "revoke all on atlas_private.review_decisions from public, anon, authenticated",
            self.sql,
        )
        self.assertIn(
            "revoke all on atlas_private.review_queue from public, anon, authenticated",
            self.sql,
        )
        self.assertNotRegex(
            self.sql,
            re.compile(r"grant\s+(?:all|select|insert|update|delete|execute).*\s+to\s+(?:anon|authenticated)"),
        )

    def test_review_contract_does_not_promote_canonical_data(self) -> None:
        forbidden = [
            "insert into public.inventory_items",
            "insert into public.recipes",
            "insert into public.recipe_ingredients",
            "update public.inventory_items",
            "update public.recipes",
        ]
        for marker in forbidden:
            self.assertNotIn(marker, self.sql)


if __name__ == "__main__":
    unittest.main()
