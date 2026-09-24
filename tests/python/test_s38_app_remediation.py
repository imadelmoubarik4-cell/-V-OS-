from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "apps/web/index.html"
# S88: the S38 rules were split verbatim into per-module fragments,
# apps/web/assets/css/legacy/s38-app-remediation--<module>.css.
CSS_FRAGMENTS = sorted((ROOT / "apps/web/assets/css/legacy").glob("s38-app-remediation--*.css"))
JS = ROOT / "apps/web/assets/js/s38-app-remediation.js"
CHECKLIST = ROOT / "docs/release/Atlas_S38_PDF_App_Remediation_Checklist.md"
DECISIONS = ROOT / "docs/release/Atlas_S38_Owner_Decisions_and_Acceptance.md"


class S38AppRemediationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = INDEX.read_text(encoding="utf-8")
        cls.css = "\n".join(path.read_text(encoding="utf-8") for path in CSS_FRAGMENTS)
        cls.javascript = JS.read_text(encoding="utf-8")
        cls.checklist = CHECKLIST.read_text(encoding="utf-8")
        cls.decisions = DECISIONS.read_text(encoding="utf-8")

    def test_remediation_assets_load_last(self):
        js_reference = "assets/js/s38-app-remediation.js"
        self.assertTrue(CSS_FRAGMENTS)
        for path in CSS_FRAGMENTS:
            css_reference = f"assets/css/legacy/{path.name}"
            self.assertEqual(self.index.count(css_reference), 1)
            self.assertLess(self.index.index(css_reference), self.index.index("</head>"))
        self.assertEqual(self.index.count(js_reference), 1)
        self.assertLess(self.index.index("assets/js/purchase-orders.js"), self.index.index(js_reference))
        self.assertLess(self.index.index(js_reference), self.index.index("</body>"))

    def test_shared_visual_contract(self):
        # S87: the S38 blue is an alias that resolves to the single Atlas blue.
        tokens = (ROOT / "apps/web/assets/css/atlas-tokens.css").read_text(encoding="utf-8")
        self.assertIn("--s38-blue: var(--atlas-accent);", tokens)
        self.assertIn("--atlas-accent: #2f80ed;", tokens)
        self.assertNotIn("--s38-blue: #4f7df3", self.css)
        for token in (
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

    def test_home_attention_and_removed_brain_card_follow_owner_contract(self):
        operations_layout = (ROOT / "apps/web/assets/js/operations-checkpoint-a-layout.js").read_text(encoding="utf-8")
        for contract in (
            "setAttentionPulse",
            "s38-attention-pulse",
            "element.dataset.s38AttentionSignature",
            "animation: s38-attention-pulse 3.2s ease-in-out 2",
        ):
            self.assertIn(contract, self.javascript if contract in self.javascript else self.css)
        self.assertIn('data-attention-required="${attentionRequired}"', operations_layout)
        self.assertIn("document.getElementById('home-focus') || document.getElementById('home-metrics')", operations_layout)
        self.assertIn("homeAnchor.insertAdjacentHTML('beforebegin', markup)", operations_layout)
        self.assertNotIn('id="home-focus"', self.index)
        self.assertNotIn("installHomeMark", self.javascript)
        self.assertNotIn("getElementById('home-focus').style.display", self.index)

    def test_scanner_controls_are_wired(self):
        scanner_css = (ROOT / "apps/web/assets/css/inventory-scanner.css").read_text(encoding="utf-8")
        for contract in (
            "handleScannerControl",
            "[data-scanner-close]",
            "[data-scanner-step]",
            "window.AtlasInventoryScanner?.close",
            "Math.max(0",
            "dispatchEvent(new Event('change'",
        ):
            self.assertIn(contract, self.javascript)
        self.assertIn("Final Atlas scanner skin", scanner_css)
        self.assertIn(".inventory-scanner-trust{border-color:#cbdafe;background:#edf3ff", scanner_css)
        self.assertIn(".inventory-scanner-primary,.inventory-scanner-manual button{border-color:#4f7df3;background:#4f7df3", scanner_css)

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

    def test_owner_corrections_are_the_authoritative_contract(self):
        for requirement in (
            "exactly four subcategories: Red, White, Rosé, and Sparkling",
            "Do not use the word “Starred.”",
            "Today's Timeline belongs on Home",
            "Each employee has one consistent soft colour",
            "one master Notifications On/Off control",
            "Welcome back",
        ):
            self.assertIn(requirement, self.decisions)
        self.assertIn("Superseded by `Atlas_S38_Owner_Decisions_and_Acceptance.md`", self.checklist)

    def test_visible_owner_requirements_are_implemented(self):
        scanner = (ROOT / "apps/web/assets/js/inventory-scanner.js").read_text(encoding="utf-8")
        stock = (ROOT / "apps/web/assets/js/stock-count-workspace.js").read_text(encoding="utf-8")
        purchasing = (ROOT / "apps/web/assets/js/purchase-orders.js").read_text(encoding="utf-8")
        messages = (ROOT / "apps/web/assets/js/team-messages.js").read_text(encoding="utf-8")
        shifts = (ROOT / "apps/web/assets/js/shifts-month-calendar.js").read_text(encoding="utf-8")
        recipes = (ROOT / "apps/web/assets/js/recipes.js").read_text(encoding="utf-8")
        knowledge = (ROOT / "apps/web/assets/js/knowledge-workspace.js").read_text(encoding="utf-8")
        brain = (ROOT / "apps/web/assets/js/brain.js").read_text(encoding="utf-8")
        settings = (ROOT / "apps/web/assets/js/settings-workspace.js").read_text(encoding="utf-8")

        self.assertNotIn("VÁ Bar · Staff only", self.index)
        self.assertIn("Welcome back", self.index)
        self.assertIn("return 'Sparkling'", self.index)
        self.assertNotIn("return 'Champagne'", self.index)
        self.assertIn("state.dirty && !window.confirm", scanner)
        self.assertIn("stock-count-category-group", stock)
        self.assertIn("purchase-suppliers-panel", self.index)
        self.assertIn("deliveryStatusLabel", purchasing)
        self.assertIn("data-team-filter=\"pinned\"", messages)
        self.assertIn("Pinned", messages)
        self.assertNotIn("Conversation starred", messages)
        self.assertIn("person-tone-", shifts)
        self.assertIn("data-shifts-month-add-day", shifts)
        self.assertIn("function openShiftEditor(date)", shifts)
        self.assertIn("addShift: openShiftEditor", shifts)
        shifts_weekly = (ROOT / "apps/web/assets/js/shifts-workspace.js").read_text(encoding="utf-8")
        self.assertIn("['month', 'calendar-range', 'Month']", shifts_weekly)
        self.assertIn("window.AtlasShiftsMonth?.open?.()", shifts_weekly)
        self.assertIn("<details class=\"recipe-foundation-card", recipes)
        self.assertIn("knowledge-editor-properties", knowledge)
        self.assertIn("brain-intelligence-grid", brain)
        self.assertIn("home-timeline", brain)
        self.assertIn("if (focusList) {", brain)
        self.assertNotIn("if (!focusList) return;", brain)
        self.assertIn("homeTimeline.style.display = view === 'dashboard' ? 'block' : 'none'", self.index)
        self.assertIn("constrainHomeTimeline", self.javascript)
        self.assertIn("Master notification control", settings)
        self.assertIn("overflow-y:scroll !important", self.css)

    def test_month_view_uses_final_atlas_skin_and_hides_global_fab(self):
        month_css = (ROOT / "apps/web/assets/css/shifts-month-editor.css").read_text(encoding="utf-8")
        for contract in (
            "Final Atlas month calendar skin",
            "--month-blue:#4f7df3",
            "background:var(--month-blue-wash)",
            "border-radius:16px",
            ".shift-month-chip.person-tone-7",
            "button.shift-month-empty",
            "gap:4px",
            "display:inline-grid!important",
        ):
            self.assertIn(contract, month_css)
        self.assertIn("polishShiftsMonth", self.javascript)
        self.assertIn("s38-month-active", self.javascript)
        self.assertIn("body.s38-month-active .fab-wrap", self.css)


if __name__ == "__main__":
    unittest.main()
