from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "apps/web/index.html"
CSS = ROOT / "apps/web/assets/css/s38-app-remediation.css"
JS = ROOT / "apps/web/assets/js/s38-app-remediation.js"
CHECKLIST = ROOT / "docs/release/Atlas_S38_PDF_App_Remediation_Checklist.md"


class S38AppRemediationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = INDEX.read_text(encoding="utf-8")
        cls.css = CSS.read_text(encoding="utf-8")
        cls.javascript = JS.read_text(encoding="utf-8")
        cls.checklist = CHECKLIST.read_text(encoding="utf-8")

    def test_remediation_assets_load_last(self):
        css_reference = "assets/css/s38-app-remediation.css"
        js_reference = "assets/js/s38-app-remediation.js"
        self.assertEqual(self.index.count(css_reference), 1)
        self.assertEqual(self.index.count(js_reference), 1)
        self.assertLess(self.index.index(css_reference), self.index.index("</head>"))
        self.assertLess(self.index.index("assets/js/purchase-orders.js"), self.index.index(js_reference))
        self.assertLess(self.index.index(js_reference), self.index.index("</body>"))

    def test_shared_visual_contract(self):
        for token in (
            "--s38-blue: #4f7df3",
            "--s38-card: #ffffff",
            "prefers-reduced-motion",
            "s38-attention-pulse",
            ".checkpoint-a-compact-card::before",
            ".inventory-scanner-panel",
            ".inventory-scanner-quantity",
            ".purchasing-workspace-tabs button.active",
            ".team-message-list",
            ".shift-month-cell.is-today",
            ".brain-hero",
            ".settings-hero",
        ):
            self.assertIn(token, self.css)
        self.assertNotIn("background: #000", self.css)
        self.assertNotIn("background:#000", self.css)

    def test_scanner_controls_are_wired(self):
        for contract in (
            "handleScannerControl",
            "[data-scanner-close]",
            "[data-scanner-step]",
            "window.AtlasInventoryScanner.close",
            "Math.max(0",
            "dispatchEvent(new Event('change'",
        ):
            self.assertIn(contract, self.javascript)

    def test_purchasing_and_message_controls_are_wired(self):
        for contract in (
            "enablePurchasingNavigation",
            "purchase-orders-tab",
            "purchase-deliveries-tab",
            "data-subview",
            "polishMessages",
            "data-team-message-list",
            "AtlasSettings?.tab",
        ):
            self.assertIn(contract, self.javascript)

    def test_existing_server_backed_features_remain_present(self):
        purchase_orders = (ROOT / "apps/web/assets/js/purchase-orders.js").read_text(encoding="utf-8")
        team_messages = (ROOT / "apps/web/assets/js/team-messages.js").read_text(encoding="utf-8")
        notifications = (ROOT / "apps/web/assets/js/notifications.js").read_text(encoding="utf-8")
        self.assertIn("function inventorySubcategory", self.index)
        self.assertIn("group === 'wine'", self.index)
        self.assertIn("atlas_purchase_order_command", purchase_orders)
        self.assertIn("data-team-star", team_messages)
        self.assertIn("subscribe", notifications)

    def test_checklist_covers_all_pdf_pages_and_production_boundary(self):
        mapped = ((1, 15), (4, 5), (8, 9), (11, 12), (13, 14))
        for page in range(1, 16):
            direct = f"| {page} |" in self.checklist
            ranged = any(
                f"| {start}–{end} |" in self.checklist and start <= page <= end
                for start, end in mapped
            )
            self.assertTrue(direct or ranged, f"PDF page {page} is not mapped")
        self.assertIn("Production remains outside the S38 run.", self.checklist)
        self.assertNotIn("supabase.co", self.javascript)
        self.assertNotIn("supabase.co", self.css)


if __name__ == "__main__":
    unittest.main()
