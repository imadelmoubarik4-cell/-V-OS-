from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260803100513_atlas_inventory_scanner_checkpoint_b.sql").read_text()
EDGE_FUNCTION = (ROOT / "supabase/functions/atlas-inventory-scanner/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER_BOOTSTRAP = (ROOT / "apps/web/assets/js/inventory-scanner-bootstrap.js").read_text()
BROWSER_MODULE = (ROOT / "apps/web/assets/js/inventory-scanner.js").read_text()


class InventoryScannerContractTests(unittest.TestCase):
    def test_private_scanner_tables_are_rls_protected(self):
        for table in (
            "inventory_scanner_settings",
            "inventory_scan_aliases",
            "inventory_scan_events",
        ):
            self.assertIn(f"alter table atlas_private.{table} enable row level security", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public,anon,authenticated", MIGRATION)
        self.assertNotIn("to authenticated using (true)", MIGRATION.lower())

    def test_preview_defaults_to_shadow_mode(self):
        self.assertIn("live_apply_enabled boolean not null default false", MIGRATION)
        self.assertIn("'va',false,false", MIGRATION)
        self.assertIn("Live inventory mutation remains disabled", MIGRATION)
        self.assertIn("'shadow_recorded'", MIGRATION)
        self.assertIn("live_inventory_mutation_enabled", MIGRATION)

    def test_aliases_require_verified_item_links_and_conflicts_are_rejected(self):
        self.assertIn("normalized_code text not null unique", MIGRATION)
        self.assertIn("verified boolean not null default true", MIGRATION)
        self.assertIn("This code is already linked to another inventory item", MIGRATION)
        self.assertIn("Scanned code is linked to a different inventory item", MIGRATION)
        self.assertIn("uncertain_image_match_auto_apply", MIGRATION)

    def test_count_events_are_idempotent_and_audited(self):
        self.assertIn("client_request_id uuid unique", MIGRATION)
        self.assertIn("where client_request_id=p_client_request_id", MIGRATION)
        self.assertIn("quantity_delta", MIGRATION)
        self.assertIn("actor_id uuid", MIGRATION)
        self.assertIn("actor_label text", MIGRATION)
        self.assertIn("finalized_at", MIGRATION)

    def test_rpc_surface_is_service_role_only(self):
        for signature in (
            "public.atlas_inventory_scanner_snapshot()",
            "public.atlas_inventory_scanner_lookup(text)",
            "public.atlas_inventory_scanner_link_code(text,text,uuid,text,text,text,uuid,text,uuid)",
            "public.atlas_inventory_scanner_record_count(uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,text,text,text,uuid,text,jsonb)",
            "public.atlas_inventory_scanner_finalize_count(uuid,text,numeric,jsonb)",
        ):
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", MIGRATION)
            self.assertIn(f"grant execute on function {signature} to service_role", MIGRATION)
        self.assertNotIn("security definer", MIGRATION.lower())

    def test_edge_function_uses_custom_profile_authorization(self):
        self.assertIn("requireActiveProfile", EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager", "bartender"])', EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager"])', EDGE_FUNCTION)
        self.assertIn("requireWriter(context)", EDGE_FUNCTION)
        self.assertIn("requireManager(context)", EDGE_FUNCTION)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE_FUNCTION)
        self.assertIn("[functions.atlas-inventory-scanner]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_live_inventory_path_is_server_side_and_setting_gated(self):
        self.assertIn("scanner?.settings?.live_apply_enabled", EDGE_FUNCTION)
        self.assertIn("applyLiveCount", EDGE_FUNCTION)
        self.assertIn("/rest/v1/rpc/adjust_inventory", EDGE_FUNCTION)
        self.assertIn('p_movement_type: "count"', EDGE_FUNCTION)
        self.assertIn("pending_live", EDGE_FUNCTION)
        self.assertIn("atlas_inventory_scanner_finalize_count", EDGE_FUNCTION)

    def test_browser_has_no_service_key_or_direct_database_access(self):
        self.assertIn("INVENTORY_SCANNER_API", BROWSER_CONFIG)
        self.assertIn("inventory-scanner-bootstrap.js", BROWSER_CONFIG)
        self.assertIn("SCANNER_SCRIPT = 'assets/js/inventory-scanner.js'", BROWSER_BOOTSTRAP)
        self.assertNotIn(
            "SUPABASE_SERVICE_ROLE_KEY",
            BROWSER_CONFIG + BROWSER_BOOTSTRAP + BROWSER_MODULE,
        )
        self.assertNotRegex(BROWSER_MODULE, r"(?:atlasSupabase|supabase|client)\s*\.\s*from\s*\(")
        self.assertNotIn("adjust_inventory", BROWSER_MODULE)
        self.assertIn("Images not uploaded", BROWSER_MODULE)
        self.assertIn("Uncertain matches never change inventory", BROWSER_MODULE)


if __name__ == "__main__":
    unittest.main()
