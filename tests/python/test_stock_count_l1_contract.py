from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
UNITS_MIGRATION = ROOT / "supabase/migrations/20260805210000_atlas_stock_counts_l1_units_and_status.sql"
PUBLICATION_MIGRATION = ROOT / "supabase/migrations/20260805211000_atlas_stock_counts_l1_manager_publication.sql"
EDGE_FUNCTION = ROOT / "supabase/functions/atlas-stock-counts/entrypoint.ts"
SUPABASE_CONFIG = ROOT / "supabase/config.toml"
WEB_CONFIG = ROOT / "apps/web/config.js"


class CheckpointL1ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.units_sql = UNITS_MIGRATION.read_text()
        cls.publication_sql = PUBLICATION_MIGRATION.read_text()
        cls.edge = EDGE_FUNCTION.read_text()
        cls.supabase_config = SUPABASE_CONFIG.read_text()
        cls.web_config = WEB_CONFIG.read_text()

    def test_original_and_normalized_count_evidence_are_preserved(self):
        for token in (
            "observed_input_quantity",
            "observed_input_unit",
            "conversion_factor",
            "conversion_basis",
            "count_evidence",
            "observed_quantity",
        ):
            self.assertIn(token, self.units_sql)
        self.assertIn("stock_count_normalize_quantity", self.units_sql)

    def test_all_required_count_units_are_supported(self):
        for unit in (
            "bottle",
            "case",
            "unit",
            "litre",
            "millilitre",
            "kilogram",
            "gram",
        ):
            self.assertIn(f"'{unit}'", self.units_sql)
            self.assertIn(f'"{unit}"', self.edge)

    def test_quantity_trust_states_are_explicit(self):
        for status in ("current", "stale", "historical", "unverified"):
            self.assertIn(f"'{status}'", self.units_sql)
        self.assertIn("historical_inventory_used_as_current", self.edge)
        self.assertIn("false", self.edge)

    def test_observation_and_verification_do_not_mutate_live_inventory(self):
        self.assertNotIn("update public.inventory_items", self.units_sql.lower())
        self.assertIn("count_observation_mutates_inventory: false", self.edge)
        self.assertIn("verification_mutates_inventory: false", self.edge)

    def test_only_manager_publication_contains_inventory_adjustment(self):
        lowered = self.publication_sql.lower()
        self.assertIn("create or replace function atlas_private.stock_count_publish", lowered)
        self.assertIn("if p_actor_role not in ('admin','manager')", lowered)
        self.assertIn("update public.inventory_items", lowered)
        self.assertIn("movement_type", lowered)
        self.assertIn("'count'", lowered)
        self.assertIn("publication_is_only_adjustment_boundary", self.units_sql)

    def test_publication_is_disabled_by_default_and_double_gated(self):
        self.assertIn("set production_apply_enabled=false", self.publication_sql)
        self.assertIn("ATLAS_STOCK_COUNT_PUBLICATION_ENABLED", self.edge)
        self.assertIn("if (!PUBLICATION_ENV_ENABLED)", self.edge)
        self.assertIn("Production stock-count publication is disabled", self.publication_sql)

    def test_private_publication_tables_are_service_role_only(self):
        lowered = self.publication_sql.lower()
        self.assertIn("enable row level security", lowered)
        self.assertIn("revoke all on atlas_private.inventory_count_publications from public,anon,authenticated", lowered)
        self.assertIn("grant all on atlas_private.inventory_count_publications to service_role", lowered)
        self.assertIn("revoke all on function public.atlas_stock_count_publish", lowered)
        self.assertIn("to service_role", lowered)

    def test_gateway_revalidates_profile_and_manager_role(self):
        self.assertIn("requireActiveProfile", self.edge)
        self.assertIn("profile?.active", self.edge)
        self.assertIn("requireManager(context)", self.edge)
        self.assertIn('case "prepare-publication"', self.edge)
        self.assertIn('case "publish"', self.edge)

    def test_runtime_configuration_uses_the_new_entrypoint(self):
        self.assertIn("[functions.atlas-stock-counts]", self.supabase_config)
        self.assertIn('entrypoint = "./functions/atlas-stock-counts/entrypoint.ts"', self.supabase_config)
        self.assertIn("STOCK_COUNTS_API", self.web_config)
        self.assertIn("stock-count-bootstrap.js", self.web_config)


if __name__ == "__main__":
    unittest.main()
