from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (
    ROOT
    / "supabase/migrations/20260917103251_link_legacy_inventory_suppliers.sql"
).read_text(encoding="utf-8")
PURCHASING = (ROOT / "apps/web/assets/js/purchase-orders.js").read_text(
    encoding="utf-8"
)


class PurchasingSupplierCanonicalizationTests(unittest.TestCase):
    def test_unlinked_inventory_supplier_names_become_canonical(self):
        lowered = MIGRATION.lower()
        self.assertIn("from public.inventory_items item", lowered)
        self.assertIn("item.supplier_id is null", lowered)
        self.assertIn("nullif(btrim(item.supplier), '') is not null", lowered)
        self.assertIn("lower(btrim(item.supplier))", lowered)
        self.assertIn("insert into public.suppliers", lowered)
        self.assertIn("update public.inventory_items item", lowered)
        self.assertIn("supplier_id = canonical_supplier_id", lowered)

    def test_existing_case_insensitive_match_is_reused_without_duplicates(self):
        lowered = MIGRATION.lower()
        self.assertIn("lower(btrim(supplier.name)) = legacy.normalized_name", lowered)
        self.assertIn("coalesce(cardinality(matching_ids), 0) > 1", lowered)
        self.assertIn(
            "multiple canonical suppliers match one legacy inventory supplier",
            lowered,
        )

    def test_migration_contains_no_private_supplier_literal(self):
        self.assertNotIn("volcanic", MIGRATION.lower())

    def test_new_order_uses_active_canonical_supplier_ids(self):
        self.assertIn("const suppliers = choices().suppliers", PURCHASING)
        self.assertIn("suppliers.filter(x=>x.active!==false)", PURCHASING)
        self.assertIn('value="${esc(x.id)}"', PURCHASING)


if __name__ == "__main__":
    unittest.main()
