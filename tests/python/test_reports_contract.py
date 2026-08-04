from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
FOUNDATION = (ROOT / "supabase/migrations/20260804093723_atlas_reports_checkpoint_h_foundation.sql").read_text()
LIVE = (ROOT / "supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql").read_text()
FIX = (ROOT / "supabase/migrations/20260804095939_atlas_reports_snapshot_variable_fix.sql").read_text()
EDGE = (ROOT / "supabase/functions/atlas-reports/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER = (ROOT / "apps/web/assets/js/reports-workspace.js").read_text()


class ReportsContractTests(unittest.TestCase):
    def test_gateway_revalidates_production_session_and_profile(self):
        self.assertIn("requireActiveProfile", EDGE)
        self.assertIn("/auth/v1/user", EDGE)
        self.assertIn("/rest/v1/profiles", EDGE)
        self.assertIn("if (!profile?.active)", EDGE)
        self.assertIn("Reports access has been removed", EDGE)
        self.assertIn('new Set(["admin", "manager", "bartender", "viewer"])', EDGE)
        self.assertIn("[functions.atlas-reports]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_production_rows_are_supplied_to_private_snapshot(self):
        for table in (
            "inventory_items",
            "recipes",
            "recipe_ingredients",
            "suppliers",
            "inventory_movements",
        ):
            self.assertIn(f'productionRows(context, "{table}"', EDGE)
        self.assertIn('branchRpc("atlas_reports_snapshot_v2"', EDGE)
        for argument in (
            "p_inventory",
            "p_recipes",
            "p_recipe_ingredients",
            "p_suppliers",
            "p_movements",
        ):
            self.assertIn(argument, EDGE)

    def test_staff_commercial_fields_are_removed_before_branch_rpc(self):
        self.assertIn("sanitizeSources", EDGE)
        self.assertIn("if (isManager(context)) return sources", EDGE)
        self.assertRegex(EDGE, r"cost_price:\s*null")
        self.assertRegex(EDGE, r"unit_cost:\s*null")
        self.assertRegex(EDGE, r"total_cost:\s*null")
        self.assertRegex(EDGE, r"supplier_id:\s*null")
        self.assertRegex(EDGE, r"suppliers:\s*\[\]")
        self.assertIn("Commercial purchasing and supplier values are restricted", EDGE)

    def test_reports_rpc_is_service_role_only(self):
        signature = (
            "public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,"
            "uuid,text,date,date,date,date,text,jsonb)"
        )
        self.assertIn(f"revoke execute on function {signature}", LIVE)
        self.assertIn("from public,anon,authenticated", LIVE)
        self.assertIn(f"grant execute on function {signature}", LIVE)
        self.assertIn("to service_role", LIVE)
        self.assertNotIn("security definer", (FOUNDATION + LIVE + FIX).lower())

    def test_snapshot_contract_is_read_only_and_truthful(self):
        self.assertIn("reports_are_read_only", LIVE)
        self.assertIn("sales_values_invented", LIVE)
        self.assertIn("source_data_modified", LIVE)
        self.assertIn("permission_sensitive_data_loaded_for_staff", LIVE)
        self.assertIn("Atlantic/Reykjavik", LIVE)
        self.assertIn("ISK", LIVE)
        self.assertIn("atlas-reports/0.2.0", LIVE)
        self.assertIn("generated_at_value", LIVE)
        self.assertIn("Corrected Reports snapshot function is missing", FIX)

    def test_edge_never_mutates_operational_source_tables(self):
        forbidden_methods = [
            'method: "PATCH"',
            'method: "DELETE"',
            'method: "PUT"',
        ]
        for forbidden in forbidden_methods:
            self.assertNotIn(forbidden, EDGE)
        self.assertNotRegex(EDGE, r"/rest/v1/(inventory_items|recipes|inventory_movements|shifts)\?[^\n]*")
        self.assertNotIn("adjust_inventory", EDGE)
        self.assertNotIn("save-shift", EDGE)

    def test_period_and_comparison_lengths_are_validated(self):
        self.assertIn("dateRangeFromRequest", EDGE)
        self.assertIn("comparisonRange", EDGE)
        self.assertIn("comparison_start_date", EDGE)
        self.assertIn("comparison_end_date", EDGE)
        self.assertIn("same number of days", EDGE)
        self.assertIn("last_30_days", EDGE)
        self.assertIn("year_to_date", EDGE)

    def test_ask_atlas_is_deterministic_and_snapshot_grounded(self):
        self.assertIn("deterministicReportAnswer", EDGE)
        self.assertIn("current Reports snapshot", EDGE)
        self.assertIn("evidence", EDGE)
        self.assertIn("limitations", EDGE)
        self.assertNotIn("OPENAI_API_KEY", EDGE)
        self.assertNotIn("Math.random", EDGE)
        self.assertNotRegex(EDGE, r"fetch\([^\n]*(openai|anthropic|gemini)")

    def test_browser_has_no_direct_database_or_privileged_access(self):
        self.assertIn("REPORTS_API", BROWSER_CONFIG)
        self.assertIn("reports-workspace.js", BROWSER_CONFIG)
        self.assertIn("window.atlasSupabase", BROWSER)
        self.assertIn("authorization: `Bearer ${session.access_token}`", BROWSER)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER_CONFIG + BROWSER)
        self.assertNotIn(".from(", BROWSER)
        self.assertNotIn("atlas_private.", BROWSER)

    def test_sales_and_purchase_order_gaps_are_explicit(self):
        self.assertIn("Sales integration is not available", EDGE)
        self.assertIn("No revenue or order values are invented", EDGE)
        self.assertIn("Purchase-order reports remain unavailable", EDGE)
        self.assertNotIn("sample revenue", EDGE.lower().replace("no sample revenue", ""))


if __name__ == "__main__":
    unittest.main()
