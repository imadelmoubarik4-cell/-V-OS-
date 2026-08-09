from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
HTML = (ROOT / "apps/web/next.html").read_text(encoding="utf-8")
RUNTIME = (ROOT / "apps/web/assets/js/atlas-next.js").read_text(encoding="utf-8")
CONFIG = (ROOT / "apps/web/assets/js/atlas-next-config.js").read_text(encoding="utf-8")
BRIDGE = (ROOT / "apps/web/assets/js/atlas-next-workspaces.js").read_text(encoding="utf-8")
PURCHASING = (ROOT / "apps/web/assets/js/atlas-next-purchasing.js").read_text(encoding="utf-8")


class AtlasNextWorkspaceReconnectionTests(unittest.TestCase):
    def test_single_shell_loads_connected_workflows(self):
        self.assertEqual(HTML.count('id="auth-screen"'), 1)
        self.assertEqual(HTML.count('id="app-shell"'), 1)
        self.assertEqual(HTML.count('data-view-panel="connected"'), 1)
        for asset in (
            "inventory-scanner.js", "item-master-workspace.js", "recipes.js",
            "import-center.js", "operations-checkpoint-a.js", "team-messages.js",
            "marketing-workspace.js", "team-profiles.source.js", "shifts-workspace.js",
            "knowledge-workspace.js", "reports-workspace.js", "settings-workspace.js",
            "system-workspace.js", "connection-center.js", "brain.js", "business.js",
        ):
            self.assertIn(f"assets/js/{asset}", HTML)
        self.assertNotRegex(HTML, r"support\.js|<x-dc|@babel|react(?:-dom)?")

    def test_routes_are_connected_without_private_browser_access(self):
        for route in (
            "operations", "inventory", "recipes", "purchasing", "imports", "review",
            "marketing", "messages", "team", "shifts", "knowledge", "brain",
            "business", "reports", "settings", "system",
        ):
            self.assertIn(f'data-view="{route}"', HTML)
            self.assertRegex(RUNTIME, rf"\b{re.escape(route)}:")
        self.assertNotIn("atlas_private.", BRIDGE)
        self.assertNotRegex(CONFIG + BRIDGE, r"SUPABASE_SERVICE_ROLE_KEY|sb_secret_")

    def test_shared_auth_and_data_boundaries_remain_authoritative(self):
        self.assertIn("window.atlasSupabase = client", RUNTIME)
        self.assertIn("AtlasData?.configure?.(client)", RUNTIME)
        self.assertIn("inventory_catalog", RUNTIME)
        self.assertIn("AtlasData.getRecipes", RUNTIME)
        self.assertIn("AtlasData.getSuppliers", RUNTIME)
        self.assertIn("AtlasData.getInventoryMovements", RUNTIME)
        self.assertIn("atlas:auth", RUNTIME)
        self.assertIn("atlas:data", RUNTIME)
        self.assertIn("atlas:navigate", RUNTIME)

    def test_controlled_inventory_workflows_are_separate(self):
        self.assertIn("AtlasInventoryScanner?.open", BRIDGE)
        self.assertIn("AtlasNextStockCounts?.open", BRIDGE)
        self.assertIn("AtlasItemMaster?.open", BRIDGE)
        inventory = re.search(
            r'<section class="view" id="view-inventory"[\s\S]*?<section class="view" id="view-connected"',
            HTML,
        ).group(0)
        self.assertNotRegex(inventory, r"adjust_inventory|data-quantity|quantity-step")

    def test_purchasing_stays_review_first(self):
        self.assertRegex(PURCHASING, r"Math\.max\(par\s*-\s*current,\s*0\)")
        self.assertIn("submissionEnabled: false", PURCHASING)
        self.assertIn("No supplier order was submitted", PURCHASING)
        self.assertIn("AtlasData.adjustInventory", PURCHASING)
        self.assertIn("AtlasData.createSupplier", PURCHASING)
        self.assertNotRegex(PURCHASING, r"purchase\.submit|submit-order|orders\.write")

    def test_import_recipe_and_message_compatibility_is_explicit(self):
        self.assertIn("data-atlas-modal", CONFIG)
        self.assertIn("import-queue-upload-button", CONFIG)
        self.assertIn("notifications-open", ROOT.joinpath("apps/web/assets/js/team-unread-badge.js").read_text(encoding="utf-8"))
        self.assertIn('id="operations-center"', HTML)
        self.assertIn('id="recipe-overlay"', HTML)
        self.assertIn('id="import-queue-rows"', HTML)


if __name__ == "__main__":
    unittest.main()
