from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
FOUNDATION = (ROOT / "supabase/migrations/20260804093723_atlas_reports_checkpoint_h_foundation.sql").read_text()
LIVE = (ROOT / "supabase/migrations/20260804095329_atlas_reports_checkpoint_h_live_sources.sql").read_text()
FIX = (ROOT / "supabase/migrations/20260804095939_atlas_reports_snapshot_variable_fix.sql").read_text()
HARDENING = (
    ROOT
    / "supabase/migrations/20260909085342_atlas_reports_recordset_wrapper_hardening.sql"
).read_text()
NULL_SAFE_WRAPPER = (
    ROOT
    / "supabase/migrations/20260909090422_atlas_reports_null_package_size_wrapper_fix.sql"
).read_text()
EDGE = (ROOT / "supabase/functions/atlas-reports/index.ts").read_text()
STOCK_PROVENANCE = (ROOT / "supabase/functions/_shared/stock-provenance.mjs").read_text()
ENTRYPOINT = (ROOT / "supabase/functions/atlas-reports/entrypoint.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER = (ROOT / "apps/web/assets/js/reports-workspace.js").read_text()


class ReportsContractTests(unittest.TestCase):
    def test_gateway_revalidates_production_session_and_profile(self):
        self.assertIn("requireActiveProfile", EDGE)
        self.assertIn('from "../_shared/auth.mjs"', EDGE)
        self.assertIn("await resolveActor(request, Deno.env, fetch", EDGE)
        self.assertIn('"profiles",', EDGE)
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
            self.assertRegex(
                EDGE,
                re.compile(rf"productionRows\(\s*context,\s*\"{table}\"", re.MULTILINE),
            )
        self.assertIn('branchRpc("atlas_reports_snapshot_v2"', EDGE)
        for argument in (
            "p_inventory",
            "p_recipes",
            "p_recipe_ingredients",
            "p_suppliers",
            "p_movements",
        ):
            self.assertIn(argument, EDGE)

    def test_rpc_recordsets_are_normalized_to_arrays_of_objects(self):
        for argument in (
            "p_inventory",
            "p_recipes",
            "p_recipe_ingredients",
            "p_suppliers",
            "p_movements",
            "p_profiles",
            "p_tasks",
            "p_progress",
        ):
            self.assertIn(f'"{argument}"', EDGE)
        # S89: the entrypoint no longer replaces the global fetch; index.ts
        # normalizes the payload and handles optional production columns.
        self.assertNotIn("globalThis.fetch =", ENTRYPOINT)
        self.assertIn('await import("./index.ts");', ENTRYPOINT)
        self.assertIn("Array.isArray(value)", EDGE)
        self.assertIn('typeof row === "object"', EDGE)
        self.assertIn("!Array.isArray(row)", EDGE)
        self.assertIn("OPTIONAL_PRODUCTION_COLUMNS", EDGE)
        self.assertIn("workspace.missing_columns", EDGE)
        self.assertIn("normalizeBranchRpcPayload", EDGE)
        self.assertIn("normalizeReportRecordset", EDGE)
        self.assertIn("const normalizedPayload", EDGE)
        self.assertIn("JSON.stringify(normalizedPayload)", EDGE)

    def test_sql_wrapper_normalizes_every_recordset_before_private_parser(self):
        for argument in (
            "p_inventory",
            "p_recipes",
            "p_recipe_ingredients",
            "p_suppliers",
            "p_movements",
            "p_profiles",
            "p_tasks",
            "p_progress",
        ):
            self.assertIn(f"coalesce({argument},'[]'::jsonb)", HARDENING)
        self.assertEqual(HARDENING.count("where jsonb_typeof(item)='object'"), 8)
        self.assertIn("cross join lateral jsonb_array_elements", HARDENING)
        self.assertIn("atlas_private.reports_snapshot_v2(", HARDENING)
        self.assertIn("security invoker", HARDENING.lower())
        self.assertIn("notify pgrst,'reload schema'", HARDENING)
        self.assertEqual(NULL_SAFE_WRAPPER.count("where jsonb_typeof(item)='object'"), 8)
        self.assertIn("coalesce(\n            to_jsonb(", NULL_SAFE_WRAPPER)
        self.assertIn("'null'::jsonb", NULL_SAFE_WRAPPER)

    def test_staff_commercial_fields_are_removed_before_branch_rpc(self):
        self.assertIn("async function reportSources", EDGE)
        self.assertRegex(EDGE, r"if \(isManager\(context\)\)\s*\{")
        self.assertIn("const operationalInventory = inventory.map", EDGE)
        self.assertIn("const operationalMovements = movements", EDGE)
        self.assertRegex(EDGE, r"cost_price:\s*null")
        self.assertRegex(EDGE, r"unit_cost:\s*null")
        self.assertRegex(EDGE, r"total_cost:\s*null")
        self.assertRegex(EDGE, r"supplier_id:\s*null")
        self.assertRegex(EDGE, r"suppliers:\s*\[\]")
        self.assertIn("strips commercial cost and supplier-spend evidence", EDGE)

    def test_reports_rpc_is_service_role_only(self):
        signature = (
            "public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,"
            "uuid,text,date,date,date,date,text,jsonb)"
        )
        self.assertIn(f"revoke execute on function {signature}", NULL_SAFE_WRAPPER)
        self.assertIn("from public,anon,authenticated", NULL_SAFE_WRAPPER)
        self.assertIn(f"grant execute on function {signature}", NULL_SAFE_WRAPPER)
        self.assertIn("to service_role", NULL_SAFE_WRAPPER)
        self.assertNotIn(
            "security definer",
            (FOUNDATION + LIVE + FIX + HARDENING + NULL_SAFE_WRAPPER).lower(),
        )

    def test_snapshot_contract_is_read_only_and_truthful(self):
        self.assertIn("function policyPayload", EDGE)
        self.assertIn("read_only: true", EDGE)
        self.assertIn("sales_integration_connected: false", EDGE)
        self.assertIn("source_data_mutation_enabled: false", EDGE)
        self.assertIn("direct_browser_table_access: false", EDGE)
        # S89: the reporting zone and business date come from the venue clock;
        # Atlantic/Reykjavik is only the fallback.
        self.assertIn('const DEFAULT_TIMEZONE = "Atlantic/Reykjavik"', EDGE)
        self.assertIn('branchRpc("atlas_settings_venue_clock"', EDGE)
        self.assertIn("reporting_timezone: clock.timezone", EDGE)
        self.assertIn('currency: "ISK"', EDGE)
        self.assertIn('x-atlas-reports-version', EDGE)
        self.assertIn('"0.3.0"', EDGE)
        self.assertIn("generated_at_value", FIX)
        self.assertIn("Corrected Reports snapshot function is missing", FIX)

    def test_live_stock_alerts_require_current_verified_counts(self):
        self.assertIn('branchRpc("atlas_stock_count_verified_balances"', EDGE)
        self.assertIn("source_updated_at", EDGE)
        self.assertIn("buildStockReport", EDGE)
        self.assertIn("applyStockTrustToWorkspace", EDGE)
        self.assertIn('HISTORICAL_OPENING_CUTOFF = "2026-07-31"', STOCK_PROVENANCE)
        self.assertIn('return "historical"', STOCK_PROVENANCE)
        self.assertIn('return "unverified"', STOCK_PROVENANCE)
        self.assertIn('return "stale"', STOCK_PROVENANCE)
        self.assertIn('quantityStatus !== "current"', STOCK_PROVENANCE)
        self.assertIn("historical_stock_used_as_live_alert: false", STOCK_PROVENANCE)
        self.assertIn("unverified_stock_used_as_live_alert: false", STOCK_PROVENANCE)
        self.assertIn("stale_stock_used_as_live_alert: false", STOCK_PROVENANCE)

    def test_edge_never_mutates_operational_source_tables(self):
        for forbidden in ('method: "PATCH"', 'method: "DELETE"', 'method: "PUT"'):
            self.assertNotIn(forbidden, EDGE)
        self.assertNotRegex(
            EDGE,
            r"/rest/v1/(inventory_items|recipes|inventory_movements|shifts)\?[^\n]*",
        )
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
        self.assertIn("current permission-filtered Reports snapshot", EDGE)
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
        self.assertNotRegex(BROWSER, r"\.from\s*\(\s*['\"]")
        self.assertNotIn("atlas_private.", BROWSER)

    def test_sales_and_purchase_order_gaps_are_explicit(self):
        self.assertIn("Sales is not connected", EDGE)
        self.assertIn("no revenue or order explanation is available", EDGE)
        self.assertIn("Purchase-order metrics remain unavailable", EDGE)
        self.assertIn("Inventory movements are not a complete purchase-order ledger", EDGE)
        self.assertNotIn("Math.random", EDGE)


if __name__ == "__main__":
    unittest.main()
