from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
RUNTIME_FIX = (
    ROOT
    / "supabase/migrations/20260806151244_atlas_phase1_recipe_catalog_runtime_fix.sql"
).read_text()


class Phase1RecipeCatalogRuntimeTests(unittest.TestCase):
    def test_recipe_catalog_uses_columns_present_in_canonical_schema(self):
        lowered = RUNTIME_FIX.lower()
        self.assertIn("create or replace function private.read_recipe_catalog", lowered)
        self.assertIn("order by ingredient.id", lowered)
        self.assertNotIn("ingredient.created_at", lowered)

    def test_runtime_fix_preserves_staff_gate_and_redacted_projection(self):
        self.assertIn("private.is_active_staff()", RUNTIME_FIX)
        self.assertIn("security definer", RUNTIME_FIX.lower())
        self.assertIn("revoke all on function private.read_recipe_catalog() from public, anon", RUNTIME_FIX)
        self.assertIn("to authenticated, service_role", RUNTIME_FIX)
        for forbidden in ("cost_price", "case_cost", "supplier_id", "total_cost", "unit_cost"):
            self.assertNotIn(forbidden, RUNTIME_FIX)


if __name__ == "__main__":
    unittest.main()
