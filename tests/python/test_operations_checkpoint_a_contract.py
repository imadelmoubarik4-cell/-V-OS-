from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260803012704_atlas_operations_checkpoint_a.sql").read_text()
SETTINGS_MIGRATION = (ROOT / "supabase/migrations/20260803014251_atlas_operations_checkpoint_a_settings.sql").read_text()
EDGE_FUNCTION = (ROOT / "supabase/functions/atlas-operations-checkpoint-a/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER_MODULE = (ROOT / "apps/web/assets/js/operations-checkpoint-a.js").read_text()


class OperationsCheckpointAContractTests(unittest.TestCase):
    def test_private_tables_are_rls_protected_and_service_role_only(self):
        for table in (
            "routine_templates",
            "routine_template_items",
            "routine_instances",
            "routine_item_results",
            "temperature_points",
            "temperature_logs",
            "operations_events",
            "integration_connections",
        ):
            self.assertIn(f"alter table atlas_private.{table} enable row level security", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public,anon,authenticated", MIGRATION)
        self.assertNotIn("to authenticated using (true)", MIGRATION.lower())

    def test_recurring_defaults_include_daily_temperature_and_three_weekly_routines(self):
        self.assertIn("'daily-temperature-log'", MIGRATION)
        self.assertIn("'sunday-inventory-reminder'", MIGRATION)
        self.assertIn("'monday-deep-cleaning'", MIGRATION)
        self.assertIn("'tuesday-storage-cleaning'", MIGRATION)
        self.assertIn("array[0,1,2,3,4,5,6]::smallint[]", MIGRATION)
        self.assertIn("array[0]::smallint[]", MIGRATION)
        self.assertIn("array[1]::smallint[]", MIGRATION)
        self.assertIn("array[2]::smallint[]", MIGRATION)

    def test_deep_cleaning_contract_covers_bar_equipment_storage_and_final_checks(self):
        required_fragments = (
            "Wash and sanitise bar tops, speed rails, bottle wells and drip trays",
            "Clean the glasswasher filter, spray arms, seals and interior",
            "wipe the ice-machine exterior, vents and surrounding area",
            "Empty and clean the large cooler table",
            "Clean the large and small wine coolers",
            "Clean both soda coolers",
            "Clean both storage coolers",
            "Deep-clean the coffee machine exterior",
            "Scrub floors, skirting, corners and accessible drains",
            "Inspect for leaks, pests, damaged seals, broken glass and maintenance issues",
            "Record temperatures after refrigerated equipment returns to stable operation",
        )
        for fragment in required_fragments:
            self.assertIn(fragment, MIGRATION)

    def test_temperature_ranges_are_manager_confirmed_not_guessed(self):
        self.assertIn("manager_configuration_required", MIGRATION)
        self.assertIn("'large-wine-cooler'", MIGRATION)
        self.assertIn("'large-cooler-table'", MIGRATION)
        self.assertIn("'storage-cooler-2'", MIGRATION)
        self.assertIn("min_temp_c,max_temp_c", MIGRATION)
        self.assertIn("null,null,true", MIGRATION)
        self.assertIn("Corrective action is required for an out-of-range temperature", MIGRATION)
        self.assertIn("range_unconfigured", MIGRATION)

    def test_tripadvisor_boundary_disallows_unsafe_review_practices(self):
        self.assertIn("'tripadvisor','Tripadvisor','reputation'", MIGRATION)
        self.assertIn("manual_management_center_until_supported_write_api_is_verified", MIGRATION)
        self.assertIn("social_post_publishing", MIGRATION)
        self.assertIn("not_applicable", MIGRATION)
        self.assertIn("no_incentivized_reviews", MIGRATION)
        self.assertIn("no_review_gating", MIGRATION)

    def test_public_rpc_surface_is_service_role_only(self):
        self.assertIn("revoke execute on function public.atlas_operations_today(date) from public,anon,authenticated", MIGRATION)
        self.assertIn("grant execute on function public.atlas_operations_today(date) to service_role", MIGRATION)
        self.assertIn("revoke execute on function public.atlas_operations_settings() from public,anon,authenticated", SETTINGS_MIGRATION)
        self.assertIn("grant execute on function public.atlas_operations_settings() to service_role", SETTINGS_MIGRATION)
        self.assertIn("security invoker", MIGRATION.lower())
        self.assertNotIn("security definer", MIGRATION.lower() + SETTINGS_MIGRATION.lower())

    def test_edge_function_uses_custom_profile_authorization(self):
        self.assertIn("requireActiveProfile", EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager", "bartender"])', EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager"])', EDGE_FUNCTION)
        self.assertIn('action === "settings"', EDGE_FUNCTION)
        self.assertIn("requireManager(context)", EDGE_FUNCTION)
        self.assertIn("atlas_operations_settings", EDGE_FUNCTION)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE_FUNCTION)
        self.assertIn("[functions.atlas-operations-checkpoint-a]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_browser_receives_no_service_role_or_direct_database_access(self):
        self.assertIn("OPERATIONS_CHECKPOINT_A_API", BROWSER_CONFIG)
        self.assertIn("operations-checkpoint-a.js", BROWSER_CONFIG)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER_CONFIG + BROWSER_MODULE)
        self.assertIsNone(re.search(r"(?:atlasSupabase|\bsb|\bclient)\.from\s*\(", BROWSER_MODULE))
        self.assertIn("No inventory quantity change from this module", BROWSER_MODULE)


if __name__ == "__main__":
    unittest.main()
