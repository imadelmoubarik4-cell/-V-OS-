from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
OPERATIONS = (ROOT / "apps/web/assets/js/phase4-operations.js").read_text()
BOOTSTRAP = (ROOT / "apps/web/assets/js/phase4-operations-bootstrap.js").read_text()
CSS = (ROOT / "apps/web/assets/css/phase4-operations.css").read_text()
MODAL = (ROOT / "apps/web/assets/js/modal.js").read_text()
COMBINED = "\n".join((OPERATIONS, BOOTSTRAP, CSS, MODAL))


class Phase4OperationalInterfaceContract(unittest.TestCase):
    def test_phase4b_is_preserved_but_not_auto_mounted(self):
        self.assertNotIn("assets/js/phase4-operations-bootstrap.js", MODAL)
        self.assertIn("assets/js/phase4-operations.js", BOOTSTRAP)
        self.assertIn("assets/css/phase4-operations.css", OPERATIONS)
        self.assertIn("window.AtlasPhase4Operations", OPERATIONS)
        self.assertIn("atlas:phase4b-ready", OPERATIONS)

    def test_real_operational_workspaces_are_reused(self):
        for value in (
            "AtlasStockCounts?.open",
            "AtlasItemMaster?.open",
            "AtlasInventoryScanner?.open",
            "AtlasRecipes?.openEditor",
            "AtlasOperations?.orderSuggestions",
        ):
            self.assertIn(value, OPERATIONS)

    def test_home_inventory_and_purchasing_structure(self):
        for value in (
            "phase4-home-operations",
            "phase4-inventory-hero",
            "phase4-purchasing-hero",
            "Stock count",
            "Item master",
            "Movements",
            "Waste",
            "Purchase drafts",
            "Deliveries",
        ):
            self.assertIn(value, OPERATIONS)

    def test_inventory_quantity_is_not_a_silent_editor(self):
        self.assertIn("input.readOnly = true", OPERATIONS)
        self.assertIn("aria-readonly", OPERATIONS)
        self.assertRegex(CSS, r"#items-body \.step-btn\s*\{\s*display:\s*none\s*!important")
        self.assertIn("manager-approved count publication", OPERATIONS)

    def test_external_side_effects_remain_blocked(self):
        for phrase in (
            "no supplier submission",
            "no automatic ordering",
            "controlled waste-write gateway is not enabled",
            "No stock was changed",
            "Not configured",
        ):
            self.assertIn(phrase.lower(), OPERATIONS.lower())

    def test_responsive_operational_surfaces_are_present(self):
        for selector in (
            "stock-count-workspace",
            "item-master-workspace",
            "inventory-scanner-panel",
            "phase4-service-card",
        ):
            self.assertIn(selector, CSS)
        self.assertIn("@media (max-width: 760px)", CSS)
        self.assertIn("@media (max-width: 520px)", CSS)
        self.assertIn("prefers-reduced-motion", CSS)
        self.assertIn('data-atlas-theme="dark"', CSS)

    def test_no_browser_privilege_or_design_runtime_regression(self):
        for forbidden in (
            "SUPABASE_SERVICE_ROLE_KEY",
            "adjust_inventory",
            "Babel.transform",
            "support.js",
        ):
            self.assertNotIn(forbidden, COMBINED)
        self.assertIsNone(re.search(r"\bservice_role\b", COMBINED, flags=re.IGNORECASE))
        self.assertIsNone(re.search(r"(?:atlasSupabase|supabase|sb|client)\s*\.\s*from\s*\(", COMBINED))
        self.assertIsNone(re.search(r"\bnew\s+Function\s*\(", COMBINED))


if __name__ == "__main__":
    unittest.main()
