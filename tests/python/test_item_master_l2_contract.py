from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
FOUNDATION = (ROOT / "supabase/migrations/20260806000337_atlas_item_master_checkpoint_l2.sql").read_text()
ALIAS_FIX = (ROOT / "supabase/migrations/20260806000401_atlas_item_master_checkpoint_l2_alias_conflict_fix.sql").read_text()
BEGIN = (ROOT / "supabase/migrations/20260806000447_atlas_item_master_checkpoint_l2_publication_begin.sql").read_text()
PRODUCTION = (ROOT / "supabase/migrations/20260806000552_atlas_item_master_checkpoint_l2_production_rpc.sql").read_text()
EDGE = (ROOT / "supabase/functions/atlas-item-master/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BOOTSTRAP = (ROOT / "apps/web/assets/js/stock-count-bootstrap.js").read_text()
BROWSER = (ROOT / "apps/web/assets/js/item-master-workspace.js").read_text()


class ItemMasterL2ContractTests(unittest.TestCase):
    def test_inventory_master_fields_are_versioned(self):
        for column in (
            "critical_minimum",
            "supplier_product_reference",
            "package_weight_g",
            "lead_time_days",
            "minimum_order_quantity",
        ):
            self.assertIn(f"add column if not exists {column}", FOUNDATION)
        self.assertIn("critical_minimum <= par_level", FOUNDATION)
        self.assertIn("minimum_order_quantity > 0", FOUNDATION)

    def test_private_drafts_publications_and_events_are_service_role_only(self):
        for table in (
            "item_master_settings",
            "item_master_drafts",
            "item_master_publications",
            "item_master_events",
        ):
            self.assertIn(f"create table if not exists atlas_private.{table}", FOUNDATION)
            self.assertIn(f"alter table atlas_private.{table} enable row level security", FOUNDATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public,anon,authenticated", FOUNDATION)
            self.assertIn(f"grant all on atlas_private.{table} to service_role", FOUNDATION)

    def test_preview_publication_defaults_off_and_preserves_source_evidence(self):
        self.assertIn("production_apply_enabled boolean not null default false", FOUNDATION)
        self.assertIn("source_match_required boolean not null default true", FOUNDATION)
        self.assertIn("master_fingerprint", EDGE)
        self.assertIn("Production item-master publication is disabled for this preview deployment", FOUNDATION)
        self.assertIn("Production item-master publication is disabled", BEGIN)

    def test_public_branch_rpcs_are_service_role_only(self):
        signatures = (
            "public.atlas_item_master_snapshot(uuid,text)",
            "public.atlas_item_master_save_draft(uuid,text,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb,jsonb,integer,uuid,text,text)",
            "public.atlas_item_master_prepare_publication(uuid,text,jsonb,uuid,text,text)",
            "public.atlas_item_master_complete_publication(uuid,text,jsonb,text,uuid,text,text)",
            "public.atlas_item_master_begin_publication(uuid,uuid,text,text)",
        )
        combined = FOUNDATION + ALIAS_FIX + BEGIN
        for signature in signatures:
            self.assertIn(f"revoke execute on function {signature}", combined)
            self.assertIn(f"grant execute on function {signature}", combined)
        self.assertIn("to service_role", combined)

    def test_manager_only_atomic_production_rpc_has_no_quantity_or_movement_path(self):
        self.assertIn("private.is_manager_or_admin()", PRODUCTION)
        self.assertIn("Only active managers can publish item-master changes", PRODUCTION)
        self.assertIn("Production item-master fields changed after draft review", PRODUCTION)
        self.assertIn("quantity_mutated',false", PRODUCTION)
        self.assertIn("inventory_movement_created',false", PRODUCTION)
        inventory_update = re.search(
            r"update public\.inventory_items\s+set(?P<body>.*?)\s+where id=p_item_id",
            PRODUCTION,
            re.IGNORECASE | re.DOTALL,
        )
        self.assertIsNotNone(inventory_update)
        self.assertNotRegex(inventory_update.group("body"), r"\bquantity\s*=")
        self.assertNotRegex(PRODUCTION, r"insert\s+into\s+public\.inventory_movements")
        self.assertNotIn("adjust_inventory", PRODUCTION)

    def test_recipe_links_and_barcode_aliases_are_conflict_checked(self):
        self.assertIn("already linked to another inventory item", PRODUCTION)
        self.assertIn("Not every recipe ingredient could be linked", PRODUCTION)
        self.assertIn("v_normalized_code", ALIAS_FIX)
        self.assertIn("already linked to another inventory item", ALIAS_FIX)
        self.assertNotIn("where normalized_code=normalized_code", ALIAS_FIX)

    def test_edge_gateway_is_custom_manager_authenticated(self):
        self.assertIn("requireManager", EDGE)
        self.assertIn("/auth/v1/user", EDGE)
        self.assertIn("/rest/v1/profiles", EDGE)
        self.assertIn('new Set(["admin", "manager"])', EDGE)
        self.assertIn("Checkpoint L2 is available only to managers and administrators", EDGE)
        self.assertIn("[functions.atlas-item-master]", CONFIG)
        self.assertRegex(CONFIG, r"\[functions\.atlas-item-master\]\s+verify_jwt\s*=\s*false")

    def test_priority_queue_uses_recipes_service_categories_counts_and_gaps(self):
        for token in (
            "usedByActiveRecipe",
            "importantCategory",
            "historicalZero",
            "count_observations",
            "adjustmentCount",
            "Supplier missing",
            "Package information missing",
            "Active recipe ingredient needs an inventory link",
        ):
            self.assertIn(token, EDGE)
        self.assertIn("priority_score", EDGE)
        self.assertIn("priority_tier", EDGE)
        self.assertIn("missing_fields", EDGE)

    def test_browser_uses_gateway_and_no_direct_operational_mutation(self):
        self.assertIn("ITEM_MASTER_API", BOOTSTRAP)
        self.assertIn("item-master-workspace.js", BOOTSTRAP)
        self.assertIn("item-master-workspace.css", BOOTSTRAP)
        self.assertIn("window.atlasSupabase", BROWSER)
        self.assertIn("Save private draft", BROWSER)
        self.assertIn("Preview publication disabled", BROWSER)
        self.assertNotRegex(BROWSER, r"\.from\s*\(\s*['\"]")
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BOOTSTRAP + BROWSER)
        self.assertNotIn("adjust_inventory", BROWSER)
        self.assertNotIn("inventory_movements", BROWSER)


if __name__ == "__main__":
    unittest.main()
