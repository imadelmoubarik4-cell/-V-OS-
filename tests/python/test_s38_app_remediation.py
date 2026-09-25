from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "apps/web/index.html"
# S88: the S38 rules were split verbatim into per-module fragments,
# apps/web/assets/css/legacy/s38-app-remediation--<module>.css.
CSS_FRAGMENTS = sorted((ROOT / "apps/web/assets/css/legacy").glob("s38-app-remediation--*.css"))
JS = ROOT / "apps/web/assets/js/s38-app-remediation.js"
# S88: each S38 fix lives in the module that renders the markup.
SCANNER = ROOT / "apps/web/assets/js/inventory-scanner.js"
LAYOUT = ROOT / "apps/web/assets/js/operations-checkpoint-a-layout.js"
PURCHASING = ROOT / "apps/web/assets/js/purchase-orders.js"
MESSAGES = ROOT / "apps/web/assets/js/team-messages.js"
SHIFTS = ROOT / "apps/web/assets/js/shifts-workspace.js"
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
        cls.owners = {path.name: path.read_text(encoding="utf-8") for path in (SCANNER, LAYOUT, PURCHASING, MESSAGES, SHIFTS)}

    def test_remediation_script_no_longer_patches_the_page(self):
        # The fixes moved to their owners; the script keeps only its marker.
        for pattern in ("new MutationObserver", "addEventListener(", "stopImmediatePropagation", "atlas:view-change"):
            self.assertNotIn(pattern, self.javascript)
        self.assertIn("window.AtlasS38Remediation", self.javascript)
        self.assertIn("s38-owner-remediation-v9", self.javascript)

    def test_remediation_assets_load_last(self):
        js_reference = "assets/js/s38-app-remediation.js"
        self.assertTrue(CSS_FRAGMENTS)
        for path in CSS_FRAGMENTS:
            css_reference = f"assets/css/legacy/{path.name}"
            self.assertEqual(self.index.count(css_reference), 1)
            self.assertLess(self.index.index(css_reference), self.index.index("</head>"))
        self.assertEqual(self.index.count(js_reference), 1)
        self.assertLess(self.index.index("assets/js/purchase-orders.js"), self.index.index(js_reference))
        self.assertIn(js_reference + "?v=20260926-s88", self.index)
        self.assertLess(self.index.index(js_reference), self.index.index("</body>"))

    def test_shared_visual_contract(self):
        # S88: the S38 blue is an alias of the single Atlas blue (--accent; Brand v1.0 #2563eb).
        tokens = (ROOT / "apps/web/assets/css/atlas-tokens.css").read_text(encoding="utf-8")
        self.assertIn("--s38-blue: var(--accent);", tokens)
        self.assertIn("--accent: #2563eb;", tokens)
        self.assertNotIn("--s38-blue: #4f7df3", self.css)
        for token in (
            "--s38-card: #ffffff",
            "prefers-reduced-motion",
            "s38-attention-pulse",
            ".checkpoint-a-compact-card::before",
            ".inventory-scanner-panel",
            ".inventory-scanner-quantity",
            ".purchasing-workspace-tabs button.active",
            ".brain-hero",
            ".settings-hero",
        ):
            self.assertIn(token, self.css)
        self.assertNotIn("background: #000", self.css)
        self.assertNotIn("background:#000", self.css)
        # S88: Messages and Shifts were rebuilt as atlas.modules sheets; their
        # S38 fragments are deleted, not merged.
        for retired in (".team-message-list", ".shift-month-cell"):
            self.assertNotIn(retired, self.css)

    def test_home_attention_and_removed_brain_card_follow_owner_contract(self):
        operations_layout = self.owners["operations-checkpoint-a-layout.js"]
        for contract in (
            "setAttentionPulse",
            "s38-attention-pulse",
            "element.dataset.s38AttentionSignature",
        ):
            self.assertIn(contract, operations_layout)
        self.assertIn("setAttentionPulse(prompt, prompt.dataset.attentionRequired === 'true')", operations_layout)
        self.assertIn("animation: s38-attention-pulse 3.2s ease-in-out 2", self.css)
        self.assertIn('data-attention-required="${attentionRequired}"', operations_layout)
        self.assertIn("document.getElementById('home-focus') || document.getElementById('home-metrics')", operations_layout)
        self.assertIn("homeAnchor.insertAdjacentHTML('beforebegin', markup)", operations_layout)
        self.assertNotIn('id="home-focus"', self.index)
        self.assertNotIn("installHomeMark", self.javascript)
        self.assertNotIn("getElementById('home-focus').style.display", self.index)

    def test_scanner_controls_are_wired(self):
        scanner_css = (ROOT / "apps/web/assets/css/inventory-scanner.css").read_text(encoding="utf-8")
        scanner = self.owners["inventory-scanner.js"]
        for contract in (
            "function stepQuantity(delta)",
            "[data-scanner-close]",
            "[data-scanner-step]",
            "closeScanner();",
            "Math.max(0",
            "dispatchEvent(new Event('change'",
            "document.addEventListener('click', handleClick, true)",
            'inputmode="decimal" aria-label="Observed inventory quantity"',
        ):
            self.assertIn(contract, scanner)
        self.assertIn("Final Atlas scanner skin", scanner_css)
        self.assertIn(".inventory-scanner-trust{border-color:#cbdafe;background:#edf3ff", scanner_css)
        self.assertIn(".inventory-scanner-primary,.inventory-scanner-manual button{border-color:#4f7df3;background:#4f7df3", scanner_css)

    def test_purchasing_and_message_controls_are_wired(self):
        purchasing = self.owners["purchase-orders.js"]
        self.assertIn("trigger.title = 'Open purchase orders'; trigger.setAttribute('aria-disabled', 'false')", purchasing)
        self.assertIn("deliveriesTrigger.title = 'Open ordered and received deliveries'", purchasing)
        # Purchasing sections are routes (#suppliers/orders, #suppliers/deliveries).
        self.assertIn("function openPurchasingSection(section)", self.index)
        self.assertIn("orders: 'purchase-orders-tab', deliveries: 'purchase-deliveries-tab'", self.index)
        messages = self.owners["team-messages.js"]
        self.assertIn('data-team-message-list role="log" aria-live="polite" aria-relevant="additions text"', messages)
        self.assertNotIn("Push notifications off", messages)
        # S88 redesign: no trust footer or FAB workaround; phones hide the tab
        # bar inside a conversation instead (spec §7.3, §8.5).
        self.assertIn("chrome?.setTabBarHidden?.('messages', inThread)", messages)
        self.assertNotIn("s38-team-active", messages)
        # S88 redesign: the bell opens the notifications panel (spec §4.9), which
        # lists unread messages and links to #settings/notifications.
        chrome = (ROOT / "apps/web/assets/js/atlas-chrome.js").read_text(encoding="utf-8")
        self.assertIn("shell.notify.setPanel(notifyPanel)", chrome)
        self.assertIn("navigate('#settings/notifications', action)", chrome)
        self.assertIn("shell.notify.contribute('messages-unread'", chrome)

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
        shifts = (ROOT / "apps/web/assets/js/shifts-workspace.js").read_text(encoding="utf-8")
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
        self.assertIn('<p class="msg-side__group">Pinned</p>', messages)
        self.assertNotIn("Conversation starred", messages)
        # One consistent colour per person (avatar tint from the person id).
        self.assertIn("function avatarTint(key)", shifts)
        self.assertIn("avatarTint(person?.id || name)", shifts)
        self.assertIn("data-shifts-add", shifts)
        self.assertIn("function openShiftEditor({ date, shift = null } = {})", shifts)
        self.assertIn("addShift: (date) => openShiftEditor({ date })", shifts)
        self.assertIn('data-shifts-mode="month"', shifts)
        self.assertIn("<details class=\"recipe-foundation-card", recipes)
        self.assertIn("data-knowledge-editor-form", knowledge)
        self.assertIn("brain-intelligence-grid", brain)
        self.assertIn("home-timeline", brain)
        self.assertIn("if (focusList) {", brain)
        self.assertNotIn("if (!focusList) return;", brain)
        self.assertIn("homeTimeline.style.display = view === 'dashboard' ? 'block' : 'none'", self.index)
        self.assertIn("homeTimeline.setAttribute('aria-hidden', String(view !== 'dashboard'))", self.index)
        self.assertIn("Master notification control", settings)
        # The message history owns its scrolling (now the Messages module sheet).
        messages_css = (ROOT / "apps/web/assets/css/team-messages.css").read_text(encoding="utf-8")
        self.assertIn(".msg-thread__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto;", messages_css)

    def test_month_view_is_part_of_shifts_on_the_design_system(self):
        css = (ROOT / "apps/web/assets/css/shifts-workspace.css").read_text(encoding="utf-8")
        for contract in (
            "@layer atlas.modules {",
            ".shifts-month__grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }",
            ".shifts-month__chip.is-unpublished { border-style: dashed;",
        ):
            self.assertIn(contract, css)
        self.assertNotIn("!important", css)
        self.assertFalse((ROOT / "apps/web/assets/css/shifts-month-editor.css").exists())
        self.assertFalse((ROOT / "apps/web/assets/js/shifts-month-calendar.js").exists())
        shifts = self.owners["shifts-workspace.js"]
        self.assertIn("function monthScheduleMarkup()", shifts)
        self.assertNotIn("s38-month-active", shifts)
        # S88 redesign: the floating action is retired (spec §4.12); nothing to hide.
        self.assertNotIn(".fab-wrap", self.css)


if __name__ == "__main__":
    unittest.main()
