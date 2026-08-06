from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
PHASE1 = (ROOT / "supabase/migrations/20260806104705_atlas_phase1_profiles_security_gate.sql").read_text()
RECIPES = (ROOT / "supabase/migrations/20260806105543_atlas_phase1_recipe_catalog_gate.sql").read_text()
STOCK_VIEWS = (ROOT / "supabase/migrations/20260806160000_atlas_phase1_stock_count_views_branch_only.sql").read_text()
INDEX = (ROOT / "apps/web/index.html").read_text()
STOCK_EDGE = (ROOT / "supabase/functions/atlas-stock-counts/entrypoint.ts").read_text()
SCANNER_EDGE = (ROOT / "supabase/functions/atlas-inventory-scanner/index.ts").read_text()
VERIFY_SQL = (ROOT / "scripts/verify_phase1_security_gate.sql").read_text()


class Phase1SecurityGateTests(unittest.TestCase):
    def test_profiles_is_the_only_authorization_registry(self):
        self.assertIn("public.profiles", PHASE1)
        self.assertIn("public.staff must not coexist", PHASE1)
        self.assertIn("'viewer'::public.staff_role", PHASE1)
        self.assertRegex(PHASE1, r"alter column active set default false")
        self.assertNotIn("create table public.staff", PHASE1.lower())

    def test_accidental_signup_never_creates_active_operational_access(self):
        self.assertIn("create or replace function public.handle_new_user", PHASE1)
        self.assertIn("'viewer'::public.staff_role", PHASE1)
        self.assertIn("false", PHASE1)
        self.assertIn("profiles_preserve_active_admin", PHASE1)

    def test_all_public_tables_are_rls_enabled_and_default_grants_are_closed(self):
        self.assertIn("alter table public.%I enable row level security", PHASE1)
        self.assertIn("revoke all privileges on table public.%I from public, anon, authenticated", PHASE1)
        self.assertIn("alter default privileges for role postgres in schema public", PHASE1)
        self.assertIn("grant all on tables to service_role", PHASE1)

    def test_commercial_tables_are_manager_only_and_staff_use_redacted_views(self):
        for table in ("inventory_items", "inventory_movements", "suppliers"):
            self.assertIn(table, PHASE1)
        self.assertIn("active managers read inventory items", PHASE1)
        self.assertIn("active managers read suppliers", PHASE1)
        self.assertIn("public.inventory_catalog", PHASE1)
        self.assertIn("public.inventory_movement_catalog", PHASE1)
        for field in ("cost_price", "case_cost", "supplier_id", "supplier_product_reference"):
            self.assertIn(field, PHASE1)
        self.assertIn("Existing inventory_catalog exposes forbidden columns", PHASE1)

    def test_recipe_cost_fields_are_hidden_behind_a_staff_catalogue(self):
        self.assertIn("active managers read recipes", RECIPES)
        self.assertIn("active managers read recipe ingredients", RECIPES)
        self.assertIn("private.read_recipe_catalog", RECIPES)
        self.assertIn("public.recipe_catalog", RECIPES)
        self.assertNotIn("unit_cost", RECIPES)
        self.assertNotIn("total_cost", RECIPES)

    def test_stock_count_views_are_branch_only_and_split_by_sensitivity(self):
        self.assertNotIn("atlas_private", PHASE1)
        self.assertNotIn("public.stock_count_summary", PHASE1)
        self.assertIn("to_regclass('atlas_private.inventory_verified_balances') is not null", STOCK_VIEWS)
        self.assertIn("public.stock_count_summary", STOCK_VIEWS)
        self.assertIn("public.stock_count_manager_summary", STOCK_VIEWS)
        self.assertIn("No verifier identity, variance, supplier or cost fields", STOCK_VIEWS)
        self.assertIn("Stock-count verification evidence is manager-only", STOCK_VIEWS)
        self.assertGreaterEqual(STOCK_VIEWS.count("security_invoker = true"), 2)

    def test_public_menu_is_the_explicit_four_column_exception(self):
        self.assertIn("security_invoker = false", PHASE1)
        self.assertIn("array['id', 'name', 'type', 'menu_price']", PHASE1)
        self.assertIn("grant select on table public.public_menu to anon", PHASE1)

    def test_inventory_adjustments_and_audit_identity_are_server_controlled(self):
        self.assertIn("Controlled inventory adjustments require an active manager", PHASE1)
        self.assertIn("atlas.allow_inventory_quantity_change", PHASE1)
        self.assertIn("insert into public.inventory_movements", PHASE1)
        self.assertIn("alter column updated_by set default", PHASE1)
        self.assertNotIn("updated_by: currentUser", INDEX)

    def test_staff_edge_payloads_are_redacted_and_live_scanner_is_manager_gated(self):
        self.assertIn("commercialAccess = MANAGER_ROLES.has", STOCK_EDGE)
        self.assertIn("inventory_catalog", STOCK_EDGE)
        self.assertIn("safeFields", STOCK_EDGE)
        live_gate = SCANNER_EDGE.index("requireManager(context);")
        live_apply = SCANNER_EDGE.index("applyLiveCount(context")
        self.assertLess(live_gate, live_apply)

    def test_verification_script_checks_tables_views_functions_and_fingerprint(self):
        for token in (
            "tables_without_rls",
            "unsafe_non_public_views",
            "browser_function_exposure",
            "atlas_stock_count_views",
            "inventory_records",
            "inventory_movements",
        ):
            self.assertIn(token, VERIFY_SQL)


if __name__ == "__main__":
    unittest.main()
