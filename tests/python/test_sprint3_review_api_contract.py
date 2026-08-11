from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SQL_PATH = ROOT / "supabase" / "drafts" / "20260802_sprint3_review_api.sql"
FUNCTION_PATH = ROOT / "supabase" / "functions" / "atlas-sprint3-review" / "index.ts"


class Sprint3ReviewApiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = SQL_PATH.read_text(encoding="utf-8").lower()
        cls.function = FUNCTION_PATH.read_text(encoding="utf-8").lower()

    def test_rpc_surface_is_service_role_only(self) -> None:
        for name in (
            "atlas_sprint3_review_summary",
            "atlas_sprint3_review_rows",
            "atlas_sprint3_review_detail",
            "atlas_sprint3_review_decide_inventory",
            "atlas_sprint3_review_decide_entity",
        ):
            self.assertIn(f"function public.{name}", self.sql)
            self.assertRegex(self.sql, re.compile(rf"revoke execute on function public\.{name}.*from public,anon,authenticated", re.S))
            self.assertRegex(self.sql, re.compile(rf"grant execute on function public\.{name}.*to service_role", re.S))

    def test_api_wrappers_are_security_invoker(self) -> None:
        self.assertGreaterEqual(self.sql.count("security invoker"), 5)
        self.assertNotIn("security definer", self.sql)

    def test_edge_function_implements_custom_manager_auth(self) -> None:
        self.assertIn("/auth/v1/user", self.function)
        self.assertIn("/rest/v1/profiles", self.function)
        self.assertIn("role !== \"admin\" && profile.role !== \"manager\"", self.function)
        self.assertIn("supabase_service_role_key", self.function)
        self.assertNotIn("service_role_key =", self.function)

    def test_pagination_cte_uses_valid_cross_join_syntax(self) -> None:
        self.assertIn("from filtered cross join controls", self.sql)
        self.assertNotIn("from filtered,cross join controls", self.sql)

    def test_edge_function_limits_review_page_size(self) -> None:
        self.assertIn("math.min(math.max", self.function)
        self.assertIn("100", self.function)

    def test_no_direct_canonical_promotion(self) -> None:
        combined = self.sql + self.function
        for marker in (
            "insert into public.inventory_items",
            "insert into public.recipes",
            "insert into public.recipe_ingredients",
        ):
            self.assertNotIn(marker, combined)


if __name__ == "__main__":
    unittest.main()
